import { Router } from 'express'
import { z } from 'zod'
import prisma from '../db'
import { getAuthContext, requireAdmin } from '../lib/auth'
import { ADMIN_TARGET_STATUSES, appendAdminStatusNote, canTransitionApplicationStatus } from '../lib/admin-driver-applications'
import { clearAssignmentTimeout, tryAssignRide } from '../services/ride-assignment'
import { getIo } from '../socket'

const router = Router()
router.use(requireAdmin)
const RIDE_STATUSES = ['REQUESTED', 'FINDING_DRIVER', 'ASSIGNED', 'ARRIVING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const
const ACTIVE_RIDE_STATUSES = ['REQUESTED', 'FINDING_DRIVER', 'ASSIGNED', 'ARRIVING', 'IN_PROGRESS'] as const
const REASSIGNABLE_RIDE_STATUSES = ['REQUESTED', 'FINDING_DRIVER', 'ASSIGNED', 'ARRIVING'] as const
const CANCELLABLE_RIDE_STATUSES = ['REQUESTED', 'FINDING_DRIVER', 'ASSIGNED', 'ARRIVING', 'IN_PROGRESS'] as const

function parseBooleanQuery(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  return value
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
    select: { id: true, status: true, notes: true }
  })
  if (!existing) return res.status(404).json({ error: 'Driver application not found' })

  if (!canTransitionApplicationStatus(existing.status, parsed.data.status)) {
    return res.status(409).json({ error: `Invalid transition from ${existing.status} to ${parsed.data.status}` })
  }

  const auth = getAuthContext(res)

  const application = await prisma.driverApplication.update({
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
