import { Router } from 'express'
import { z } from 'zod'
import prisma from '../db.js'
import { getIo } from '../socket.js'
import { clearAssignmentTimeout, reassignRide } from '../services/ride-assignment.js'
import { getAuthContext, requireAuth } from '../lib/auth.js'

const router = Router()

// Active ride for a driver — must be before /:id to avoid route conflict
router.get('/driver/:driverId/active', async (req, res) => {
  const ride = await prisma.ride.findFirst({
    where: {
      driverId: req.params.driverId,
      status: { in: ['ASSIGNED', 'ARRIVING', 'IN_PROGRESS'] }
    },
    orderBy: { createdAt: 'desc' },
    include: {
      rider: { select: { id: true, name: true, phone: true } },
      events: {
        orderBy: { createdAt: 'desc' },
        take: 20
      }
    }
  })
  res.json({ ride: ride ?? null })
})

router.get('/:id', async (req, res) => {
  const ride = await prisma.ride.findUnique({
    where: { id: req.params.id },
    include: {
      driver: {
        select: {
          id: true,
          name: true,
          phone: true,
          vehicle: {
            select: {
              model: true,
              plateNumber: true
            }
          }
        }
      }
    }
  })
  if (!ride) return res.status(404).json({ error: 'Ride not found' })
  res.json(ride)
})

const VALID_STATUSES = ['FINDING_DRIVER', 'ASSIGNED', 'ARRIVING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const
const DRIVER_CONTROLLED_STATUSES = new Set(['ARRIVING', 'IN_PROGRESS', 'COMPLETED'])
const NEXT_STATUSES: Record<string, Array<(typeof VALID_STATUSES)[number]>> = {
  REQUESTED: ['FINDING_DRIVER', 'CANCELLED'],
  FINDING_DRIVER: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['ARRIVING', 'CANCELLED', 'FINDING_DRIVER'],
  ARRIVING: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: []
}

router.post('/:id/status', async (req, res) => {
  const parsed = z.object({ status: z.enum(VALID_STATUSES), driverId: z.string().optional() }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }

  const existing = await prisma.ride.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true, driverId: true, riderId: true }
  })
  if (!existing) return res.status(404).json({ error: 'Ride not found' })

  if (!NEXT_STATUSES[existing.status]?.includes(parsed.data.status)) {
    return res.status(409).json({ error: `Invalid transition from ${existing.status} to ${parsed.data.status}` })
  }

  if (DRIVER_CONTROLLED_STATUSES.has(parsed.data.status)) {
    if (!parsed.data.driverId || parsed.data.driverId !== existing.driverId) {
      return res.status(403).json({ error: 'Only assigned driver can update this status' })
    }
  }

  const ride = await prisma.ride.update({
    where: { id: existing.id },
    data: {
      status: parsed.data.status,
      events: { create: [{ type: parsed.data.status }] }
    }
  })

  if (['ARRIVING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(parsed.data.status)) {
    clearAssignmentTimeout(ride.id)
  }

  if ((parsed.data.status === 'COMPLETED' || parsed.data.status === 'CANCELLED') && ride.driverId) {
    await prisma.driverLocation.update({
      where: { driverId: ride.driverId },
      data: { isAvailable: true }
    })
  }

  const io = getIo()
  io.to(`ride:${ride.id}`).emit('ride:status', { rideId: ride.id, status: ride.status })
  io.to(`user:${existing.riderId}`).emit('ride:status', { rideId: ride.id, status: ride.status })
  if (existing.driverId) {
    io.to(`user:${existing.driverId}`).emit('ride:status', { rideId: ride.id, status: ride.status, riderId: existing.riderId })
  }

  res.json({ id: ride.id, status: ride.status })
})

router.post('/:id/decline', async (req, res) => {
  const parsed = z.object({ driverId: z.string() }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }

  const existing = await prisma.ride.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true, driverId: true }
  })
  if (!existing) return res.status(404).json({ error: 'Ride not found' })
  if (existing.status !== 'ASSIGNED') {
    return res.status(409).json({ error: 'Only assigned rides can be declined' })
  }
  if (existing.driverId !== parsed.data.driverId) {
    return res.status(403).json({ error: 'Only assigned driver can decline this ride' })
  }

  await prisma.ride.update({
    where: { id: existing.id },
    data: {
      events: { create: [{ type: 'DRIVER_DECLINED', metadata: { driverId: parsed.data.driverId } }] }
    }
  })

  await reassignRide(existing.id, [parsed.data.driverId])
  res.json({ ok: true })
})

router.post('/:id/rate', requireAuth, async (req, res) => {
  const auth = getAuthContext(res)
  const parsed = z.object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(300).optional(),
    tags: z.array(z.string().min(1).max(50)).max(10).optional()
  }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }

  const ride = await prisma.ride.findUnique({
    where: { id: req.params.id },
    select: { id: true, riderId: true, driverId: true, status: true }
  })
  if (!ride) return res.status(404).json({ error: 'Ride not found' })
  if (ride.riderId !== auth.userId) return res.status(403).json({ error: 'Only ride rider can submit rating' })
  if (ride.status !== 'COMPLETED') return res.status(409).json({ error: 'Ride must be completed before rating' })

  const existingRating = await prisma.rideEvent.findFirst({
    where: { rideId: ride.id, type: 'RATED' },
    select: { id: true }
  })
  if (existingRating) return res.status(409).json({ error: 'Rating already submitted for this ride' })

  const event = await prisma.rideEvent.create({
    data: {
      rideId: ride.id,
      type: 'RATED',
      metadata: {
        riderId: auth.userId,
        driverId: ride.driverId,
        rating: parsed.data.rating,
        comment: parsed.data.comment ?? null,
        tags: parsed.data.tags ?? []
      }
    }
  })

  return res.json({ ok: true, id: event.id })
})

router.post('/:id/events', async (req, res) => {
  const parsed = z.object({ type: z.string(), metadata: z.any().optional() }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }

  const event = await prisma.rideEvent.create({
    data: {
      rideId: req.params.id,
      type: parsed.data.type,
      metadata: parsed.data.metadata
    }
  })

  res.json({ id: event.id, event: event.type })
})

router.get('/', async (_req, res) => {
  const items = await prisma.ride.findMany({ orderBy: { createdAt: 'desc' }, take: 20 })
  res.json({ items })
})

export default router
