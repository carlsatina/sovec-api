import { Router } from 'express'
import { z } from 'zod'
import prisma from '../db.js'
import { Prisma } from '@prisma/client'
import { getAuthContext, requireAdmin } from '../lib/auth.js'
import { ADMIN_TARGET_STATUSES, appendAdminStatusNote, canTransitionApplicationStatus } from '../lib/admin-driver-applications.js'
import { clearAssignmentTimeout, tryAssignRide } from '../services/ride-assignment.js'
import { getIo } from '../socket.js'
import { getSafetyTemplates, notifySafetyEscalation, notifySafetyResolution, SAFETY_TEMPLATE_KEYS, updateSafetyTemplate } from '../services/safety-notifier.js'

const router = Router()
router.use(requireAdmin)
const RIDE_STATUSES = ['REQUESTED', 'FINDING_DRIVER', 'ASSIGNED', 'ARRIVING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const
const ACTIVE_RIDE_STATUSES = ['REQUESTED', 'FINDING_DRIVER', 'ASSIGNED', 'ARRIVING', 'IN_PROGRESS'] as const
const REASSIGNABLE_RIDE_STATUSES = ['REQUESTED', 'FINDING_DRIVER', 'ASSIGNED', 'ARRIVING'] as const
const CANCELLABLE_RIDE_STATUSES = ['REQUESTED', 'FINDING_DRIVER', 'ASSIGNED', 'ARRIVING', 'IN_PROGRESS'] as const
const VEHICLE_STATUSES = ['AVAILABLE', 'IN_USE', 'CHARGING', 'MAINTENANCE'] as const
const PAYMENT_STATUSES = ['PENDING', 'PAID', 'VERIFIED', 'FAILED', 'REFUND_PENDING', 'REFUNDED'] as const
const PAYMENT_METHODS = ['CASH', 'EWALLET', 'CARD'] as const
const SUPPORT_TICKET_STATUSES = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED'] as const
const REVENUE_PAYMENT_STATUSES = ['PAID', 'VERIFIED'] as const
const SAFETY_INCIDENT_CATEGORIES = ['SOS', 'SAFETY'] as const
const SAFETY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
const SAFETY_TIMELINE_EVENT_TYPES = ['SOS_TRIGGERED', 'ADMIN_SAFETY_ACKNOWLEDGED', 'ADMIN_SAFETY_ASSIGNED', 'ADMIN_SAFETY_ESCALATED', 'ADMIN_SAFETY_RESOLVED', 'ADMIN_SAFETY_CLOSED'] as const

function parseBooleanQuery(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return value
}

function startOfDay(date: Date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function dayKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

type SafetyIncidentMeta = {
  rideId?: string | null
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null
  reporterRole?: 'PASSENGER' | 'DRIVER' | null
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  assigneeId?: string | null
  acknowledgedAt?: string | null
  resolvedAt?: string | null
}

function parseSafetyIncidentMeta(description: string | null | undefined): { meta: SafetyIncidentMeta, noteText: string } {
  if (!description) return { meta: {}, noteText: '' }
  if (description.startsWith('[META]')) {
    const newlineIndex = description.indexOf('\n')
    const jsonRaw = (newlineIndex > -1 ? description.slice('[META]'.length, newlineIndex) : description.slice('[META]'.length)).trim()
    const noteText = newlineIndex > -1 ? description.slice(newlineIndex + 1).trim() : ''
    try {
      const parsed = JSON.parse(jsonRaw) as SafetyIncidentMeta
      return { meta: parsed ?? {}, noteText }
    } catch {
      return { meta: {}, noteText: description }
    }
  }

  // Legacy SOS format: ride:<id>;severity:<x>;reporterRole:<x>;note:<text>
  const tokens = description.split(';').map((part) => part.trim()).filter(Boolean)
  const legacy: SafetyIncidentMeta = {}
  for (const token of tokens) {
    const idx = token.indexOf(':')
    if (idx < 0) continue
    const key = token.slice(0, idx).trim()
    const value = token.slice(idx + 1).trim()
    if (!value) continue
    if (key === 'ride') legacy.rideId = value
    if (key === 'severity' && ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value)) {
      legacy.severity = value as SafetyIncidentMeta['severity']
      legacy.priority = value as SafetyIncidentMeta['priority']
    }
    if (key === 'reporterRole' && ['PASSENGER', 'DRIVER'].includes(value)) {
      legacy.reporterRole = value as SafetyIncidentMeta['reporterRole']
    }
  }
  return { meta: legacy, noteText: description }
}

function toSafetyIncidentDescription(meta: SafetyIncidentMeta, noteText: string) {
  const normalized: SafetyIncidentMeta = {
    rideId: meta.rideId ?? null,
    severity: meta.severity ?? null,
    reporterRole: meta.reporterRole ?? null,
    priority: meta.priority ?? 'HIGH',
    assigneeId: meta.assigneeId ?? null,
    acknowledgedAt: meta.acknowledgedAt ?? null,
    resolvedAt: meta.resolvedAt ?? null
  }
  const note = noteText.trim()
  return `[META]${JSON.stringify(normalized)}\n${note}`
}

function slaOverdueThresholdMinutes(priority: SafetyIncidentMeta['priority']) {
  if (priority === 'CRITICAL') return 15
  if (priority === 'HIGH') return 30
  if (priority === 'MEDIUM') return 120
  return 360
}

async function appendSafetyTimelineEvent(input: {
  incidentId: string
  rideId?: string | null
  eventType: (typeof SAFETY_TIMELINE_EVENT_TYPES)[number]
  metadata: Record<string, unknown>
}) {
  if (!input.rideId) return
  await prisma.rideEvent.create({
    data: {
      rideId: input.rideId,
      type: input.eventType,
      metadata: {
        incidentId: input.incidentId,
        ...input.metadata
      }
    }
  }).catch(() => null)
}

async function enrichSafetyIncidents(items: Array<{
  id: string
  userId: string
  category: string
  description: string
  status: string
  createdAt: Date
  user: {
    id: string
    name: string
    phone: string
    email: string | null
    role: 'PASSENGER' | 'DRIVER' | 'ADMIN'
  }
}>) {
  const parsedById = new Map(items.map((item) => [item.id, parseSafetyIncidentMeta(item.description)]))
  const rideIds = Array.from(
    new Set(items.map((item) => parsedById.get(item.id)?.meta.rideId).filter((value): value is string => Boolean(value)))
  )

  let timelineByRideId = new Map<string, Array<{ id: string; type: string; createdAt: Date; metadata: Prisma.JsonValue | null }>>()
  if (rideIds.length > 0) {
    const events = await prisma.rideEvent.findMany({
      where: {
        rideId: { in: rideIds },
        type: { in: [...SAFETY_TIMELINE_EVENT_TYPES] }
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, rideId: true, type: true, createdAt: true, metadata: true }
    })

    timelineByRideId = events.reduce((acc, evt) => {
      const prev = acc.get(evt.rideId) ?? []
      prev.push(evt)
      acc.set(evt.rideId, prev)
      return acc
    }, new Map<string, Array<{ id: string; type: string; createdAt: Date; metadata: Prisma.JsonValue | null }>>())
  }

  return items.map((item) => {
    const parsed = parsedById.get(item.id) ?? { meta: {}, noteText: '' }
    const rideId = parsed.meta.rideId ?? null
    const timelineEvents = (rideId ? timelineByRideId.get(rideId) : []) ?? []
    const incidentTimeline = timelineEvents.filter((evt) => {
      const metadata = (evt.metadata ?? {}) as Record<string, unknown>
      if (evt.type === 'SOS_TRIGGERED') {
        return metadata.incidentId ? String(metadata.incidentId) === item.id : true
      }
      return String(metadata.incidentId ?? '') === item.id
    })

    const acknowledgedAt = parsed.meta.acknowledgedAt
      ? new Date(parsed.meta.acknowledgedAt)
      : (incidentTimeline.find((evt) => evt.type === 'ADMIN_SAFETY_ACKNOWLEDGED')?.createdAt ?? null)
    const resolvedAt = parsed.meta.resolvedAt
      ? new Date(parsed.meta.resolvedAt)
      : (incidentTimeline.find((evt) => evt.type === 'ADMIN_SAFETY_RESOLVED' || evt.type === 'ADMIN_SAFETY_CLOSED')?.createdAt ?? null)

    const ackSeconds = acknowledgedAt ? Math.max(0, Math.round((acknowledgedAt.getTime() - item.createdAt.getTime()) / 1000)) : null
    const resolveSeconds = resolvedAt ? Math.max(0, Math.round((resolvedAt.getTime() - item.createdAt.getTime()) / 1000)) : null
    const overdueThresholdMinutes = slaOverdueThresholdMinutes(parsed.meta.priority ?? 'HIGH')
    const overdue = !resolvedAt && (Date.now() - item.createdAt.getTime()) > overdueThresholdMinutes * 60 * 1000

    return {
      ...item,
      incidentMeta: {
        ...parsed.meta,
        priority: parsed.meta.priority ?? 'HIGH',
        assigneeId: parsed.meta.assigneeId ?? null,
        acknowledgedAt: acknowledgedAt ? acknowledgedAt.toISOString() : null,
        resolvedAt: resolvedAt ? resolvedAt.toISOString() : null,
        noteText: parsed.noteText
      },
      timeline: incidentTimeline.map((evt) => ({
        id: evt.id,
        type: evt.type,
        createdAt: evt.createdAt,
        metadata: evt.metadata
      })),
      sla: {
        ackSeconds,
        resolveSeconds,
        overdue,
        overdueThresholdMinutes
      }
    }
  })
}

router.get('/driver-applications', async (req, res) => {
  const parsed = z.object({
    status: z.enum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'INTERVIEW', 'APPROVED', 'REJECTED']).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  }).safeParse(req.query)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const where = {
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.q
      ? {
        OR: [
          { fullName: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { phone: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { email: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { user: { name: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { user: { phone: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { user: { email: { contains: parsed.data.q, mode: 'insensitive' as const } } }
        ]
      }
      : {})
  }

  const skip = (parsed.data.page - 1) * parsed.data.limit

  const [items, total] = await Promise.all([
    prisma.driverApplication.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: parsed.data.limit,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, role: true, createdAt: true } },
        documents: true,
        availability: true
      }
    }),
    prisma.driverApplication.count({ where })
  ])

  res.json({
    items,
    page: parsed.data.page,
    limit: parsed.data.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.limit))
  })
})

router.post('/driver-applications/:id/status', async (req, res) => {
  const parsed = z.object({
    status: z.enum(ADMIN_TARGET_STATUSES as [typeof ADMIN_TARGET_STATUSES[number], ...typeof ADMIN_TARGET_STATUSES[number][]]),
    reason: z.string().trim().min(2).max(300).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })
  if (parsed.data.status === 'REJECTED' && !parsed.data.reason) {
    return res.status(422).json({ error: 'Reason is required when rejecting an application' })
  }

  const existing = await prisma.driverApplication.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, status: true, notes: true }
  })
  if (!existing) return res.status(404).json({ error: 'Driver application not found' })

  if (!canTransitionApplicationStatus(existing.status, parsed.data.status)) {
    return res.status(409).json({ error: `Invalid transition from ${existing.status} to ${parsed.data.status}` })
  }

  const auth = getAuthContext(res)

  const application = await prisma.$transaction(async (tx) => {
    const updated = await tx.driverApplication.update({
      where: { id: req.params.id },
      data: {
        status: parsed.data.status,
        notes: appendAdminStatusNote(existing.notes, {
          adminId: auth.userId,
          status: parsed.data.status,
          reason: parsed.data.reason
        })
      }
    })

    if (parsed.data.status === 'APPROVED') {
      // Promote approved applicants to driver role; ADMIN users stay unchanged.
      await tx.user.updateMany({
        where: { id: existing.userId, role: 'PASSENGER' },
        data: { role: 'DRIVER' }
      })
    }

    return updated
  })

  res.json({ ok: true, application })
})

router.post('/driver-applications/:id/interview', async (req, res) => {
  const parsed = z.object({ interviewAt: z.string().datetime() }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const existing = await prisma.driverApplication.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true, notes: true }
  })
  if (!existing) return res.status(404).json({ error: 'Driver application not found' })
  if (!canTransitionApplicationStatus(existing.status, 'INTERVIEW')) {
    return res.status(409).json({ error: `Invalid transition from ${existing.status} to INTERVIEW` })
  }

  const auth = getAuthContext(res)

  const application = await prisma.driverApplication.update({
    where: { id: req.params.id },
    data: {
      interviewAt: new Date(parsed.data.interviewAt),
      status: 'INTERVIEW',
      notes: appendAdminStatusNote(existing.notes, {
        adminId: auth.userId,
        status: 'INTERVIEW',
        reason: `Interview scheduled for ${parsed.data.interviewAt}`
      })
    }
  })

  res.json({ ok: true, application })
})

router.get('/rides', async (req, res) => {
  const parsed = z.object({
    status: z.enum(RIDE_STATUSES).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    activeOnly: z.preprocess(parseBooleanQuery, z.boolean()).default(true),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  }).safeParse(req.query)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const where = {
    ...(parsed.data.status
      ? { status: parsed.data.status }
      : parsed.data.activeOnly
        ? { status: { in: [...ACTIVE_RIDE_STATUSES] } }
        : {}),
    ...(parsed.data.q
      ? {
        OR: [
          { id: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { pickupAddress: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { dropoffAddress: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { rider: { name: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { rider: { phone: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { driver: { name: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { driver: { phone: { contains: parsed.data.q, mode: 'insensitive' as const } } }
        ]
      }
      : {})
  }

  const skip = (parsed.data.page - 1) * parsed.data.limit

  const [items, total] = await Promise.all([
    prisma.ride.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parsed.data.limit,
      include: {
        rider: { select: { id: true, name: true, phone: true } },
        driver: { select: { id: true, name: true, phone: true } },
        events: {
          orderBy: { createdAt: 'desc' },
          take: 10
        }
      }
    }),
    prisma.ride.count({ where })
  ])

  return res.json({
    items,
    page: parsed.data.page,
    limit: parsed.data.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.limit))
  })
})

router.post('/rides/:id/force-cancel', async (req, res) => {
  const parsed = z.object({ reason: z.string().trim().min(2).max(300).optional() }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const existing = await prisma.ride.findUnique({
    where: { id: req.params.id },
    select: { id: true, riderId: true, driverId: true, status: true }
  })
  if (!existing) return res.status(404).json({ error: 'Ride not found' })
  if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
    return res.status(409).json({ error: `Ride is already ${existing.status.toLowerCase()}` })
  }

  clearAssignmentTimeout(existing.id)
  const auth = getAuthContext(res)

  const cancelResult = await prisma.$transaction(async (tx) => {
    const updated = await tx.ride.updateMany({
      where: {
        id: existing.id,
        status: { in: [...CANCELLABLE_RIDE_STATUSES] }
      },
      data: { status: 'CANCELLED' }
    })
    if (updated.count === 0) {
      const current = await tx.ride.findUnique({
        where: { id: existing.id },
        select: { id: true, status: true }
      })
      return { ok: false as const, current }
    }

    await tx.rideEvent.create({
      data: {
        rideId: existing.id,
        type: 'ADMIN_FORCE_CANCEL',
        metadata: {
          adminId: auth.userId,
          reason: parsed.data.reason ?? null
        }
      }
    })

    return { ok: true as const }
  })
  if (!cancelResult.ok) {
    if (!cancelResult.current) return res.status(404).json({ error: 'Ride not found' })
    return res.status(409).json({ error: `Ride is already ${cancelResult.current.status.toLowerCase()}` })
  }

  if (existing.driverId) {
    await prisma.driverLocation.update({
      where: { driverId: existing.driverId },
      data: { isAvailable: true }
    }).catch(() => null)
  }

  const io = getIo()
  io.to(`ride:${existing.id}`).emit('ride:status', { rideId: existing.id, status: 'CANCELLED' })
  io.to(`user:${existing.riderId}`).emit('ride:status', { rideId: existing.id, status: 'CANCELLED' })
  if (existing.driverId) {
    io.to(`user:${existing.driverId}`).emit('ride:status', { rideId: existing.id, status: 'CANCELLED' })
  }

  return res.json({ ok: true, id: existing.id, status: 'CANCELLED' })
})

router.post('/rides/:id/reassign', async (req, res) => {
  const parsed = z.object({
    reason: z.string().trim().min(2).max(300).optional(),
    preferredDriverId: z.string().trim().min(1).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const existing = await prisma.ride.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      riderId: true,
      driverId: true,
      status: true
    }
  })
  if (!existing) return res.status(404).json({ error: 'Ride not found' })
  if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(existing.status)) {
    return res.status(409).json({ error: `Cannot reassign ride in ${existing.status} state` })
  }

  clearAssignmentTimeout(existing.id)
  const auth = getAuthContext(res)
  const previousDriverId = existing.driverId ?? null
  const claimResult = await prisma.$transaction(async (tx) => {
    const updated = await tx.ride.updateMany({
      where: {
        id: existing.id,
        status: { in: [...REASSIGNABLE_RIDE_STATUSES] },
        driverId: existing.driverId
      },
      data: {
        driverId: null,
        status: 'FINDING_DRIVER'
      }
    })
    if (updated.count === 0) {
      const current = await tx.ride.findUnique({
        where: { id: existing.id },
        select: { id: true, status: true }
      })
      return { ok: false as const, current }
    }

    await tx.rideEvent.create({
      data: {
        rideId: existing.id,
        type: 'ADMIN_REASSIGN',
        metadata: {
          adminId: auth.userId,
          reason: parsed.data.reason ?? null,
          previousDriverId,
          preferredDriverId: parsed.data.preferredDriverId ?? null
        }
      }
    })
    return { ok: true as const }
  })
  if (!claimResult.ok) {
    if (!claimResult.current) return res.status(404).json({ error: 'Ride not found' })
    return res.status(409).json({ error: `Cannot reassign ride in ${claimResult.current.status} state` })
  }

  if (previousDriverId) {
    await prisma.driverLocation.update({
      where: { driverId: previousDriverId },
      data: { isAvailable: true }
    }).catch(() => null)
  }

  if (parsed.data.preferredDriverId) {
    const preferredLocation = await prisma.driverLocation.findUnique({
      where: { driverId: parsed.data.preferredDriverId },
      select: { driverId: true, isAvailable: true }
    })

    if (preferredLocation?.isAvailable) {
      const preferredAssignResult = await prisma.$transaction(async (tx) => {
        const updated = await tx.ride.updateMany({
          where: {
            id: existing.id,
            status: 'FINDING_DRIVER',
            driverId: null
          },
          data: {
            driverId: parsed.data.preferredDriverId,
            status: 'ASSIGNED'
          }
        })
        if (updated.count === 0) return null

        await tx.rideEvent.create({
          data: {
            rideId: existing.id,
            type: 'ASSIGNED',
            metadata: { source: 'ADMIN_REASSIGN' }
          }
        })

        return tx.ride.findUnique({
          where: { id: existing.id },
          select: { id: true, status: true, driverId: true }
        })
      })
      if (!preferredAssignResult?.driverId) {
        return res.status(409).json({ error: 'Ride state changed during preferred reassignment. Please retry.' })
      }

      await prisma.driverLocation.update({
        where: { driverId: parsed.data.preferredDriverId },
        data: { isAvailable: false }
      }).catch(() => null)

      const io = getIo()
      io.to(`ride:${existing.id}`).emit('ride:status', { rideId: existing.id, status: preferredAssignResult.status, driverId: preferredAssignResult.driverId })
      io.to(`user:${existing.riderId}`).emit('ride:status', { rideId: existing.id, status: preferredAssignResult.status, driverId: preferredAssignResult.driverId })
      io.to(`user:${parsed.data.preferredDriverId}`).emit('ride:status', { rideId: existing.id, status: preferredAssignResult.status, riderId: existing.riderId })

      return res.json({ ok: true, id: existing.id, status: preferredAssignResult.status, driverId: preferredAssignResult.driverId })
    }
  }

  await tryAssignRide(existing.id, previousDriverId ? [previousDriverId] : [])

  const latest = await prisma.ride.findUnique({
    where: { id: existing.id },
    select: { id: true, status: true, driverId: true }
  })
  if (!latest) return res.status(404).json({ error: 'Ride not found after reassign' })
  return res.json({ ok: true, id: latest.id, status: latest.status, driverId: latest.driverId ?? null })
})

router.get('/payments', async (req, res) => {
  const parsed = z.object({
    status: z.enum(PAYMENT_STATUSES).optional(),
    method: z.enum(PAYMENT_METHODS).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  }).safeParse(req.query)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const where = {
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.method ? { method: parsed.data.method } : {}),
    ...(parsed.data.q
      ? {
        OR: [
          { id: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { rideId: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { reference: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { ride: { rider: { name: { contains: parsed.data.q, mode: 'insensitive' as const } } } },
          { ride: { rider: { phone: { contains: parsed.data.q, mode: 'insensitive' as const } } } },
          { ride: { driver: { name: { contains: parsed.data.q, mode: 'insensitive' as const } } } },
          { ride: { driver: { phone: { contains: parsed.data.q, mode: 'insensitive' as const } } } }
        ]
      }
      : {})
  }

  const skip = (parsed.data.page - 1) * parsed.data.limit
  const [items, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parsed.data.limit,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, role: true } },
        ride: {
          select: {
            id: true,
            status: true,
            pickupAddress: true,
            dropoffAddress: true,
            rider: { select: { id: true, name: true, phone: true } },
            driver: { select: { id: true, name: true, phone: true } }
          }
        }
      }
    }),
    prisma.payment.count({ where })
  ])

  return res.json({
    items,
    page: parsed.data.page,
    limit: parsed.data.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.limit))
  })
})

router.post('/payments/:id/verify', async (req, res) => {
  const parsed = z.object({ note: z.string().trim().max(300).optional() }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const payment = await prisma.payment.findUnique({
    where: { id: req.params.id },
    select: { id: true, rideId: true, status: true }
  })
  if (!payment) return res.status(404).json({ error: 'Payment not found' })
  if (payment.status === 'REFUNDED' || payment.status === 'REFUND_PENDING') {
    return res.status(409).json({ error: `Cannot verify payment in ${payment.status} state` })
  }

  const auth = getAuthContext(res)
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'VERIFIED' }
    })
    await tx.rideEvent.create({
      data: {
        rideId: payment.rideId,
        type: 'ADMIN_PAYMENT_VERIFIED',
        metadata: {
          adminId: auth.userId,
          paymentId: payment.id,
          note: parsed.data.note ?? null
        }
      }
    })
    return next
  })

  return res.json({ ok: true, payment: updated })
})

router.post('/payments/:id/fail', async (req, res) => {
  const parsed = z.object({ reason: z.string().trim().min(2).max(300).optional() }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const payment = await prisma.payment.findUnique({
    where: { id: req.params.id },
    select: { id: true, rideId: true, status: true }
  })
  if (!payment) return res.status(404).json({ error: 'Payment not found' })
  if (payment.status === 'REFUNDED') {
    return res.status(409).json({ error: 'Cannot fail a refunded payment' })
  }

  const auth = getAuthContext(res)
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'FAILED' }
    })
    await tx.rideEvent.create({
      data: {
        rideId: payment.rideId,
        type: 'ADMIN_PAYMENT_FAILED',
        metadata: {
          adminId: auth.userId,
          paymentId: payment.id,
          reason: parsed.data.reason ?? null
        }
      }
    })
    return next
  })

  return res.json({ ok: true, payment: updated })
})

router.post('/payments/:id/refund', async (req, res) => {
  const parsed = z.object({
    reason: z.string().trim().min(2).max(300),
    amount: z.number().positive().optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const payment = await prisma.payment.findUnique({
    where: { id: req.params.id },
    select: { id: true, rideId: true, status: true, amount: true }
  })
  if (!payment) return res.status(404).json({ error: 'Payment not found' })
  if (payment.status === 'REFUNDED' || payment.status === 'REFUND_PENDING') {
    return res.status(409).json({ error: `Refund already requested or completed for this payment (${payment.status})` })
  }
  if (typeof parsed.data.amount === 'number' && parsed.data.amount > payment.amount) {
    return res.status(422).json({ error: 'Refund amount cannot exceed payment amount' })
  }

  const auth = getAuthContext(res)
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'REFUND_PENDING' }
    })
    await tx.rideEvent.create({
      data: {
        rideId: payment.rideId,
        type: 'ADMIN_REFUND_REQUESTED',
        metadata: {
          adminId: auth.userId,
          paymentId: payment.id,
          reason: parsed.data.reason,
          requestedAmount: parsed.data.amount ?? payment.amount
        }
      }
    })
    return next
  })

  return res.json({ ok: true, payment: updated })
})

router.get('/support/tickets', async (req, res) => {
  const parsed = z.object({
    status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
    category: z.string().trim().min(1).max(120).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  }).safeParse(req.query)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const where = {
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.category ? { category: { contains: parsed.data.category, mode: 'insensitive' as const } } : {}),
    ...(parsed.data.q
      ? {
        OR: [
          { id: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { category: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { description: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { user: { name: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { user: { phone: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { user: { email: { contains: parsed.data.q, mode: 'insensitive' as const } } }
        ]
      }
      : {})
  }

  const skip = (parsed.data.page - 1) * parsed.data.limit
  const [items, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parsed.data.limit,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, role: true } }
      }
    }),
    prisma.supportTicket.count({ where })
  ])

  return res.json({
    items,
    page: parsed.data.page,
    limit: parsed.data.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.limit))
  })
})

router.post('/support/tickets/:id/status', async (req, res) => {
  const parsed = z.object({
    status: z.enum(SUPPORT_TICKET_STATUSES),
    note: z.string().trim().max(300).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const ticket = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, category: true, status: true }
  })
  if (!ticket) return res.status(404).json({ error: 'Support ticket not found' })

  const auth = getAuthContext(res)
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.supportTicket.update({
      where: { id: ticket.id },
      data: { status: parsed.data.status }
    })

    await tx.notification.create({
      data: {
        userId: ticket.userId,
        title: `Support ticket ${parsed.data.status.toLowerCase().replace('_', ' ')}`,
        body: parsed.data.note?.trim() || `Ticket ${ticket.id.slice(0, 8)} (${ticket.category}) status changed to ${parsed.data.status}.`,
        type: 'SUPPORT_UPDATE'
      }
    })

    return next
  })

  return res.json({ ok: true, ticket: updated })
})

router.get('/safety/templates', async (_req, res) => {
  const templates = await getSafetyTemplates()
  const items = Object.entries(templates).map(([key, value]) => ({
    key,
    subject: value.subject,
    body: value.body
  }))
  return res.json({ items })
})

router.put('/safety/templates/:key', async (req, res) => {
  const keyParsed = z.object({
    key: z.enum(SAFETY_TEMPLATE_KEYS)
  }).safeParse(req.params)
  if (!keyParsed.success) return res.status(422).json({ error: keyParsed.error.flatten() })

  const bodyParsed = z.object({
    subject: z.string().trim().min(2).max(200).optional(),
    body: z.string().trim().min(2).max(2000).optional()
  }).safeParse(req.body)
  if (!bodyParsed.success) return res.status(422).json({ error: bodyParsed.error.flatten() })
  if (!bodyParsed.data.subject && !bodyParsed.data.body) {
    return res.status(422).json({ error: 'At least one of subject or body is required' })
  }

  const updated = await updateSafetyTemplate(keyParsed.data.key, bodyParsed.data)
  return res.json({
    ok: true,
    template: {
      key: keyParsed.data.key,
      ...updated
    }
  })
})

router.get('/safety/incidents', async (req, res) => {
  const parsed = z.object({
    status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
    priority: z.enum(SAFETY_PRIORITIES).optional(),
    assigneeId: z.string().trim().min(1).optional(),
    overdue: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    activeOnly: z.preprocess(parseBooleanQuery, z.boolean()).default(true),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  }).safeParse(req.query)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const where = {
    category: { in: [...SAFETY_INCIDENT_CATEGORIES] },
    ...(parsed.data.status
      ? { status: parsed.data.status }
      : parsed.data.activeOnly
        ? { status: { in: ['OPEN', 'IN_REVIEW'] } }
        : {}),
    ...(parsed.data.q
      ? {
        OR: [
          { id: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { description: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { user: { name: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { user: { phone: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { user: { email: { contains: parsed.data.q, mode: 'insensitive' as const } } }
        ]
      }
      : {})
  }

  const applyPostFilters = Boolean(parsed.data.priority || parsed.data.assigneeId || typeof parsed.data.overdue === 'boolean')
  const filterEnrichedItems = (enriched: Awaited<ReturnType<typeof enrichSafetyIncidents>>) => enriched.filter((item) => {
    if (parsed.data.priority && (item.incidentMeta?.priority ?? 'HIGH') !== parsed.data.priority) return false
    if (parsed.data.assigneeId && (item.incidentMeta?.assigneeId ?? null) !== parsed.data.assigneeId) return false
    if (typeof parsed.data.overdue === 'boolean' && item.sla.overdue !== parsed.data.overdue) return false
    return true
  })

  if (!applyPostFilters) {
    const skip = (parsed.data.page - 1) * parsed.data.limit
    const [items, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parsed.data.limit,
        include: {
          user: { select: { id: true, name: true, phone: true, email: true, role: true } }
        }
      }),
      prisma.supportTicket.count({ where })
    ])

    const enriched = await enrichSafetyIncidents(items)
    return res.json({
      items: filterEnrichedItems(enriched),
      page: parsed.data.page,
      limit: parsed.data.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / parsed.data.limit))
    })
  }

  const batchSize = 200
  let offset = 0
  let filtered: Awaited<ReturnType<typeof enrichSafetyIncidents>> = []

  while (true) {
    const batch = await prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: batchSize,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, role: true } }
      }
    })
    if (batch.length === 0) break
    offset += batch.length
    const enrichedBatch = await enrichSafetyIncidents(batch)
    filtered = filtered.concat(filterEnrichedItems(enrichedBatch))
    if (batch.length < batchSize) break
  }

  const pagedItems = filtered.slice((parsed.data.page - 1) * parsed.data.limit, parsed.data.page * parsed.data.limit)
  const nextTotal = filtered.length

  return res.json({
    items: pagedItems,
    page: parsed.data.page,
    limit: parsed.data.limit,
    total: nextTotal,
    totalPages: Math.max(1, Math.ceil(nextTotal / parsed.data.limit))
  })
})

router.post('/safety/incidents/:id/resolve', async (req, res) => {
  const parsed = z.object({
    status: z.enum(['RESOLVED', 'CLOSED']).default('RESOLVED'),
    action: z.string().trim().min(2).max(120),
    note: z.string().trim().max(500).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const incident = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, category: true, status: true, description: true }
  })
  if (!incident || !SAFETY_INCIDENT_CATEGORIES.includes(incident.category as (typeof SAFETY_INCIDENT_CATEGORIES)[number])) {
    return res.status(404).json({ error: 'Safety incident not found' })
  }

  const auth = getAuthContext(res)
  const reporter = await prisma.user.findUnique({
    where: { id: incident.userId },
    select: { id: true, name: true, phone: true, email: true }
  })
  const parsedMeta = parseSafetyIncidentMeta(incident.description)
  const nowIso = new Date().toISOString()
  const nextMeta: SafetyIncidentMeta = {
    ...parsedMeta.meta,
    priority: parsedMeta.meta.priority ?? 'HIGH',
    acknowledgedAt: parsedMeta.meta.acknowledgedAt ?? nowIso,
    resolvedAt: nowIso
  }
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.supportTicket.update({
      where: { id: incident.id },
      data: {
        status: parsed.data.status,
        description: toSafetyIncidentDescription(nextMeta, parsedMeta.noteText)
      }
    })

    await tx.notification.create({
      data: {
        userId: incident.userId,
        title: `Safety incident ${parsed.data.status.toLowerCase()}`,
        body: `${parsed.data.action}${parsed.data.note ? `: ${parsed.data.note}` : ''}`,
        type: 'SAFETY_INCIDENT_UPDATE'
      }
    })

    return next
  })

  await appendSafetyTimelineEvent({
    incidentId: incident.id,
    rideId: nextMeta.rideId ?? null,
    eventType: parsed.data.status === 'CLOSED' ? 'ADMIN_SAFETY_CLOSED' : 'ADMIN_SAFETY_RESOLVED',
    metadata: {
      adminId: auth.userId,
      action: parsed.data.action,
      note: parsed.data.note ?? null
    }
  })

  const delivery = await notifySafetyResolution({
    incidentId: incident.id,
    status: parsed.data.status,
    action: parsed.data.action,
    note: parsed.data.note ?? null,
    reporter: reporter
      ? {
        phone: reporter.phone,
        email: reporter.email ?? null
      }
      : undefined
  })

  return res.json({
    ok: true,
    incident: updated,
    resolution: {
      adminId: auth.userId,
      action: parsed.data.action,
      note: parsed.data.note ?? null
    },
    delivery
  })
})

router.post('/safety/incidents/:id/acknowledge', async (req, res) => {
  const parsed = z.object({
    note: z.string().trim().max(500).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const incident = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, category: true, description: true }
  })
  if (!incident || !SAFETY_INCIDENT_CATEGORIES.includes(incident.category as (typeof SAFETY_INCIDENT_CATEGORIES)[number])) {
    return res.status(404).json({ error: 'Safety incident not found' })
  }

  const auth = getAuthContext(res)
  const parsedMeta = parseSafetyIncidentMeta(incident.description)
  const nowIso = new Date().toISOString()
  const nextMeta: SafetyIncidentMeta = {
    ...parsedMeta.meta,
    priority: parsedMeta.meta.priority ?? 'HIGH',
    acknowledgedAt: parsedMeta.meta.acknowledgedAt ?? nowIso,
    assigneeId: parsedMeta.meta.assigneeId ?? auth.userId
  }

  const updated = await prisma.supportTicket.update({
    where: { id: incident.id },
    data: {
      status: 'IN_REVIEW',
      description: toSafetyIncidentDescription(nextMeta, parsedMeta.noteText)
    }
  })

  await appendSafetyTimelineEvent({
    incidentId: incident.id,
    rideId: nextMeta.rideId ?? null,
    eventType: 'ADMIN_SAFETY_ACKNOWLEDGED',
    metadata: { adminId: auth.userId, note: parsed.data.note ?? null }
  })

  return res.json({ ok: true, incident: updated })
})

router.post('/safety/incidents/:id/assign', async (req, res) => {
  const parsed = z.object({
    assigneeId: z.string().trim().min(1).optional(),
    note: z.string().trim().max(500).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const incident = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, category: true, description: true }
  })
  if (!incident || !SAFETY_INCIDENT_CATEGORIES.includes(incident.category as (typeof SAFETY_INCIDENT_CATEGORIES)[number])) {
    return res.status(404).json({ error: 'Safety incident not found' })
  }

  const auth = getAuthContext(res)
  const assigneeId = parsed.data.assigneeId ?? auth.userId
  const assignee = await prisma.user.findUnique({
    where: { id: assigneeId },
    select: { id: true, role: true }
  })
  if (!assignee || assignee.role !== 'ADMIN') {
    return res.status(422).json({ error: 'Assignee must be an ADMIN user' })
  }

  const parsedMeta = parseSafetyIncidentMeta(incident.description)
  const nowIso = new Date().toISOString()
  const nextMeta: SafetyIncidentMeta = {
    ...parsedMeta.meta,
    priority: parsedMeta.meta.priority ?? 'HIGH',
    assigneeId,
    acknowledgedAt: parsedMeta.meta.acknowledgedAt ?? nowIso
  }

  const updated = await prisma.supportTicket.update({
    where: { id: incident.id },
    data: {
      status: 'IN_REVIEW',
      description: toSafetyIncidentDescription(nextMeta, parsedMeta.noteText)
    }
  })

  await appendSafetyTimelineEvent({
    incidentId: incident.id,
    rideId: nextMeta.rideId ?? null,
    eventType: 'ADMIN_SAFETY_ASSIGNED',
    metadata: { adminId: auth.userId, assigneeId, note: parsed.data.note ?? null }
  })

  return res.json({ ok: true, incident: updated, assigneeId })
})

router.post('/safety/incidents/:id/escalate', async (req, res) => {
  const parsed = z.object({
    priority: z.enum(SAFETY_PRIORITIES),
    reason: z.string().trim().min(2).max(500)
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const incident = await prisma.supportTicket.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, category: true, description: true }
  })
  if (!incident || !SAFETY_INCIDENT_CATEGORIES.includes(incident.category as (typeof SAFETY_INCIDENT_CATEGORIES)[number])) {
    return res.status(404).json({ error: 'Safety incident not found' })
  }

  const auth = getAuthContext(res)
  const parsedMeta = parseSafetyIncidentMeta(incident.description)
  const nextMeta: SafetyIncidentMeta = {
    ...parsedMeta.meta,
    priority: parsed.data.priority
  }

  const updated = await prisma.supportTicket.update({
    where: { id: incident.id },
    data: {
      status: 'IN_REVIEW',
      description: toSafetyIncidentDescription(nextMeta, parsedMeta.noteText)
    }
  })

  await appendSafetyTimelineEvent({
    incidentId: incident.id,
    rideId: nextMeta.rideId ?? null,
    eventType: 'ADMIN_SAFETY_ESCALATED',
    metadata: { adminId: auth.userId, priority: parsed.data.priority, reason: parsed.data.reason }
  })
  const reporter = await prisma.user.findUnique({
    where: { id: incident.userId },
    select: { id: true, name: true, phone: true, email: true }
  })
  const delivery = await notifySafetyEscalation({
    incidentId: incident.id,
    priority: parsed.data.priority,
    reason: parsed.data.reason,
    rideId: nextMeta.rideId ?? null,
    reporter: reporter
      ? {
        name: reporter.name,
        phone: reporter.phone,
        email: reporter.email ?? null
      }
      : undefined
  })

  return res.json({ ok: true, incident: updated, priority: parsed.data.priority, delivery })
})

router.get('/analytics/overview', async (_req, res) => {
  const now = new Date()
  const todayStart = startOfDay(now)
  const tomorrowStart = addDays(todayStart, 1)
  const last30DaysStart = addDays(todayStart, -29)

  const [todayRides, todayCompleted, todayCancelled, todayRevenue, activeDrivers, totalRides30d, completedRides30d, cancelledRides30d, revenue30d] = await Promise.all([
    prisma.ride.count({
      where: { createdAt: { gte: todayStart, lt: tomorrowStart } }
    }),
    prisma.ride.count({
      where: { status: 'COMPLETED', createdAt: { gte: todayStart, lt: tomorrowStart } }
    }),
    prisma.ride.count({
      where: { status: 'CANCELLED', createdAt: { gte: todayStart, lt: tomorrowStart } }
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        status: { in: [...REVENUE_PAYMENT_STATUSES] },
        createdAt: { gte: todayStart, lt: tomorrowStart }
      }
    }),
    prisma.user.count({
      where: {
        role: 'DRIVER',
        driverLocation: { is: { isAvailable: true } }
      }
    }),
    prisma.ride.count({
      where: { createdAt: { gte: last30DaysStart, lt: tomorrowStart } }
    }),
    prisma.ride.count({
      where: { status: 'COMPLETED', createdAt: { gte: last30DaysStart, lt: tomorrowStart } }
    }),
    prisma.ride.count({
      where: { status: 'CANCELLED', createdAt: { gte: last30DaysStart, lt: tomorrowStart } }
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        status: { in: [...REVENUE_PAYMENT_STATUSES] },
        createdAt: { gte: last30DaysStart, lt: tomorrowStart }
      }
    })
  ])

  const completionRate30d = totalRides30d > 0 ? (completedRides30d / totalRides30d) * 100 : 0
  const cancellationRate30d = totalRides30d > 0 ? (cancelledRides30d / totalRides30d) * 100 : 0

  return res.json({
    today: {
      rides: todayRides,
      completedRides: todayCompleted,
      cancelledRides: todayCancelled,
      revenue: Number(todayRevenue._sum.amount ?? 0)
    },
    activeDrivers,
    rolling30d: {
      rides: totalRides30d,
      completedRides: completedRides30d,
      cancelledRides: cancelledRides30d,
      revenue: Number(revenue30d._sum.amount ?? 0),
      completionRate: Number(completionRate30d.toFixed(2)),
      cancellationRate: Number(cancellationRate30d.toFixed(2))
    }
  })
})

router.get('/analytics/trends', async (req, res) => {
  const parsed = z.object({
    days: z.coerce.number().int().min(1).max(90).default(7)
  }).safeParse(req.query)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const days = parsed.data.days
  const todayStart = startOfDay(new Date())
  const rangeStart = addDays(todayStart, -(days - 1))
  const rangeEnd = addDays(todayStart, 1)

  const [rides, payments] = await Promise.all([
    prisma.ride.findMany({
      where: {
        createdAt: { gte: rangeStart, lt: rangeEnd }
      },
      select: { createdAt: true, status: true }
    }),
    prisma.payment.findMany({
      where: {
        createdAt: { gte: rangeStart, lt: rangeEnd },
        status: { in: [...REVENUE_PAYMENT_STATUSES] }
      },
      select: { createdAt: true, amount: true }
    })
  ])

  const buckets = new Map<string, { day: string, rides: number, completedRides: number, cancelledRides: number, revenue: number }>()
  for (let i = 0; i < days; i += 1) {
    const d = addDays(rangeStart, i)
    const key = dayKey(d)
    buckets.set(key, { day: key, rides: 0, completedRides: 0, cancelledRides: 0, revenue: 0 })
  }

  for (const ride of rides) {
    const key = dayKey(ride.createdAt)
    const bucket = buckets.get(key)
    if (!bucket) continue
    bucket.rides += 1
    if (ride.status === 'COMPLETED') bucket.completedRides += 1
    if (ride.status === 'CANCELLED') bucket.cancelledRides += 1
  }

  for (const payment of payments) {
    const key = dayKey(payment.createdAt)
    const bucket = buckets.get(key)
    if (!bucket) continue
    bucket.revenue += Number(payment.amount)
  }

  return res.json({
    days,
    items: Array.from(buckets.values())
  })
})

router.get('/vehicles', async (req, res) => {
  const parsed = z.object({
    status: z.enum(VEHICLE_STATUSES).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  }).safeParse(req.query)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const where = {
    ...(parsed.data.status ? { status: parsed.data.status } : {}),
    ...(parsed.data.q
      ? {
        OR: [
          { plateNumber: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { model: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { color: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { driver: { name: { contains: parsed.data.q, mode: 'insensitive' as const } } },
          { driver: { phone: { contains: parsed.data.q, mode: 'insensitive' as const } } }
        ]
      }
      : {})
  }
  const skip = (parsed.data.page - 1) * parsed.data.limit

  const [items, total] = await Promise.all([
    prisma.vehicle.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parsed.data.limit,
      include: {
        driver: {
          select: { id: true, name: true, phone: true, email: true, role: true }
        }
      }
    }),
    prisma.vehicle.count({ where })
  ])

  return res.json({
    items,
    page: parsed.data.page,
    limit: parsed.data.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.limit))
  })
})

router.get('/drivers/available', async (req, res) => {
  const parsed = z.object({
    q: z.string().trim().min(1).max(120).optional(),
    availableOnly: z.preprocess(parseBooleanQuery, z.boolean()).default(true),
    unassignedOnly: z.preprocess(parseBooleanQuery, z.boolean()).default(true),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  }).safeParse(req.query)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const where = {
    role: 'DRIVER' as const,
    ...(parsed.data.q
      ? {
        OR: [
          { name: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { phone: { contains: parsed.data.q, mode: 'insensitive' as const } },
          { email: { contains: parsed.data.q, mode: 'insensitive' as const } }
        ]
      }
      : {}),
    ...(parsed.data.availableOnly
      ? { driverLocation: { is: { isAvailable: true } } }
      : {}),
    ...(parsed.data.unassignedOnly
      ? { vehicle: { is: null } }
      : {})
  }

  const skip = (parsed.data.page - 1) * parsed.data.limit
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parsed.data.limit,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        createdAt: true,
        driverLocation: {
          select: { isAvailable: true, updatedAt: true, lat: true, lng: true }
        },
        vehicle: {
          select: { id: true, plateNumber: true, status: true }
        }
      }
    }),
    prisma.user.count({ where })
  ])

  return res.json({
    items,
    page: parsed.data.page,
    limit: parsed.data.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / parsed.data.limit))
  })
})

router.post('/vehicles', async (req, res) => {
  const parsed = z.object({
    plateNumber: z.string().trim().min(3).max(20),
    model: z.string().trim().min(2).max(120),
    capacity: z.number().int().min(1).max(24),
    color: z.string().trim().min(2).max(50).optional(),
    status: z.enum(VEHICLE_STATUSES).optional(),
    batteryCapacityKwh: z.number().min(0).max(500).optional(),
    batteryLevel: z.number().int().min(0).max(100).optional(),
    driverId: z.string().trim().min(1).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  if (parsed.data.driverId) {
    const driver = await prisma.user.findUnique({
      where: { id: parsed.data.driverId },
      select: { id: true, role: true }
    })
    if (!driver) return res.status(404).json({ error: 'Driver not found' })
    if (driver.role !== 'DRIVER') return res.status(422).json({ error: 'Assigned user must have DRIVER role' })

    const existingVehicle = await prisma.vehicle.findUnique({
      where: { driverId: parsed.data.driverId },
      select: { id: true }
    })
    if (existingVehicle) return res.status(409).json({ error: 'Driver already has an assigned vehicle' })
  }

  try {
    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: parsed.data.plateNumber.toUpperCase(),
        model: parsed.data.model,
        capacity: parsed.data.capacity,
        color: parsed.data.color,
        status: parsed.data.status ?? 'AVAILABLE',
        batteryCapacityKwh: parsed.data.batteryCapacityKwh,
        batteryLevel: parsed.data.batteryLevel,
        driverId: parsed.data.driverId ?? null
      },
      include: {
        driver: { select: { id: true, name: true, phone: true, email: true, role: true } }
      }
    })
    return res.status(201).json({ ok: true, vehicle })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target) ? err.meta.target : []
      if (target.includes('plateNumber')) {
        return res.status(409).json({ error: 'Plate number already exists' })
      }
    }
    throw err
  }
})

router.post('/vehicles/:id/assign-driver', async (req, res) => {
  const parsed = z.object({
    driverId: z.string().trim().min(1).nullable().optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: req.params.id },
    select: { id: true, driverId: true }
  })
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' })

  const nextDriverId = parsed.data.driverId ?? null
  if (nextDriverId) {
    const driver = await prisma.user.findUnique({
      where: { id: nextDriverId },
      select: { id: true, role: true }
    })
    if (!driver) return res.status(404).json({ error: 'Driver not found' })
    if (driver.role !== 'DRIVER') return res.status(422).json({ error: 'Assigned user must have DRIVER role' })

    const assignedVehicle = await prisma.vehicle.findFirst({
      where: { driverId: nextDriverId, id: { not: vehicle.id } },
      select: { id: true }
    })
    if (assignedVehicle) return res.status(409).json({ error: 'Driver already has an assigned vehicle' })
  }

  const updated = await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: { driverId: nextDriverId },
    include: {
      driver: { select: { id: true, name: true, phone: true, email: true, role: true } }
    }
  })

  return res.json({ ok: true, vehicle: updated })
})

router.post('/vehicles/:id/status', async (req, res) => {
  const parsed = z.object({
    status: z.enum(VEHICLE_STATUSES),
    batteryLevel: z.number().int().min(0).max(100).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: req.params.id },
    select: { id: true }
  })
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' })

  const updated = await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: {
      status: parsed.data.status,
      ...(typeof parsed.data.batteryLevel === 'number' ? { batteryLevel: parsed.data.batteryLevel } : {})
    },
    include: {
      driver: { select: { id: true, name: true, phone: true, email: true, role: true } }
    }
  })

  return res.json({ ok: true, vehicle: updated })
})

router.get('/pricing', async (_req, res) => {
  const config = await prisma.fareConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      baseFare: 55,
      perKmRate: 15,
      perMinuteRate: 2.8,
      minimumFare: 55,
      currency: 'PHP'
    }
  })

  return res.json({ config })
})

router.put('/pricing', async (req, res) => {
  const parsed = z.object({
    baseFare: z.number().min(0).max(10_000),
    perKmRate: z.number().min(0).max(5_000),
    perMinuteRate: z.number().min(0).max(5_000),
    minimumFare: z.number().min(0).max(10_000),
    currency: z.string().trim().length(3).optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const nextMinimum = parsed.data.minimumFare
  const nextBase = parsed.data.baseFare
  if (nextMinimum < nextBase) {
    return res.status(422).json({ error: 'minimumFare must be greater than or equal to baseFare' })
  }

  const config = await prisma.fareConfig.upsert({
    where: { id: 'default' },
    update: {
      baseFare: parsed.data.baseFare,
      perKmRate: parsed.data.perKmRate,
      perMinuteRate: parsed.data.perMinuteRate,
      minimumFare: parsed.data.minimumFare,
      currency: (parsed.data.currency ?? 'PHP').toUpperCase()
    },
    create: {
      id: 'default',
      baseFare: parsed.data.baseFare,
      perKmRate: parsed.data.perKmRate,
      perMinuteRate: parsed.data.perMinuteRate,
      minimumFare: parsed.data.minimumFare,
      currency: (parsed.data.currency ?? 'PHP').toUpperCase()
    }
  })

  return res.json({ ok: true, config })
})

export default router
