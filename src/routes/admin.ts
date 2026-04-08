import { Router } from 'express'
import { z } from 'zod'
import prisma from '../db'
import { Prisma } from '@prisma/client'
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
const VEHICLE_STATUSES = ['AVAILABLE', 'IN_USE', 'CHARGING', 'MAINTENANCE'] as const

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
