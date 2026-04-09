import { Router } from 'express'
import { z } from 'zod'
import prisma from '../db.js'
import { getIo } from '../socket.js'
import { clearAssignmentTimeout, tryAssignRide } from '../services/ride-assignment.js'
import { calculateFare } from '../services/fare-config.js'

const router = Router()

const fareEstimateSchema = z.object({
  pickupLat: z.number(),
  pickupLng: z.number(),
  dropoffLat: z.number(),
  dropoffLng: z.number()
})

router.post('/estimate', async (req, res) => {
  const parsed = fareEstimateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }

  const { pickupLat, pickupLng, dropoffLat, dropoffLng } = parsed.data
  const fare = await calculateFare(pickupLat, pickupLng, dropoffLat, dropoffLng)

  res.json(fare)
})

const createBookingSchema = z.object({
  riderId: z.string(),
  pickupAddress: z.string(),
  pickupLat: z.number(),
  pickupLng: z.number(),
  dropoffAddress: z.string(),
  dropoffLat: z.number(),
  dropoffLng: z.number(),
  paymentMethod: z.enum(['CASH', 'EWALLET', 'CARD'])
})

router.post('/', async (req, res) => {
  const parsed = createBookingSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }

  const { riderId, pickupAddress, pickupLat, pickupLng, dropoffAddress, dropoffLat, dropoffLng, paymentMethod } = parsed.data

  const fare = await calculateFare(pickupLat, pickupLng, dropoffLat, dropoffLng)
  const fareAmount = fare.total

  const ride = await prisma.ride.create({
    data: {
      riderId,
      status: 'FINDING_DRIVER',
      pickupAddress,
      pickupLat,
      pickupLng,
      dropoffAddress,
      dropoffLat,
      dropoffLng,
      fareAmount,
      currency: fare.currency,
      paymentMethod,
      events: {
        create: [{ type: 'FINDING_DRIVER' }]
      }
    }
  })

  const io = getIo()
  io.to(`ride:${ride.id}`).emit('ride:status', { rideId: ride.id, status: ride.status })
  io.to(`user:${riderId}`).emit('ride:status', { rideId: ride.id, status: ride.status })

  try {
    await tryAssignRide(ride.id)
  } catch {
    // Driver matching failed — ride stays in FINDING_DRIVER, can be retried
  }

  res.json({ ok: true, rideId: ride.id, status: ride.status })
})

router.post('/:id/cancel', async (req, res) => {
  const id = req.params.id
  clearAssignmentTimeout(id)

  const existing = await prisma.ride.findUnique({ where: { id } })
  if (!existing) return res.status(404).json({ error: 'Ride not found' })
  if (['CANCELLED', 'COMPLETED'].includes(existing.status)) {
    return res.status(409).json({ error: `Ride is already ${existing.status.toLowerCase()}` })
  }

  const ride = await prisma.ride.update({
    where: { id },
    data: {
      status: 'CANCELLED',
      events: { create: [{ type: 'CANCELLED' }] }
    }
  })

  const io = getIo()
  io.to(`ride:${ride.id}`).emit('ride:status', { rideId: ride.id, status: ride.status })

  res.json({ ok: true, status: ride.status })
})

export default router
