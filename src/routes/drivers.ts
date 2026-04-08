import { Router } from 'express'
import { z } from 'zod'
import prisma from '../db'

const router = Router()

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (v: number) => (v * Math.PI) / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

const locationSchema = z.object({
  driverId: z.string(),
  lat: z.number(),
  lng: z.number(),
  isAvailable: z.boolean().optional()
})

router.post('/location', async (req, res) => {
  const parsed = locationSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }

  const { driverId, lat, lng, isAvailable } = parsed.data

  const location = await prisma.driverLocation.upsert({
    where: { driverId },
    update: { lat, lng, isAvailable: isAvailable ?? true },
    create: { driverId, lat, lng, isAvailable: isAvailable ?? true }
  })

  return res.json({ ok: true, location })
})

router.post('/:id/availability', async (req, res) => {
  const driverId = req.params.id
  const parsed = z.object({ isAvailable: z.boolean() }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }

  const location = await prisma.driverLocation.update({
    where: { driverId },
    data: { isAvailable: parsed.data.isAvailable }
  })

  return res.json({ ok: true, location })
})

router.get('/:id/session', async (req, res) => {
  const driverId = req.params.id

  const [location, ride] = await Promise.all([
    prisma.driverLocation.findUnique({
      where: { driverId },
      select: { lat: true, lng: true, isAvailable: true, updatedAt: true }
    }),
    prisma.ride.findFirst({
      where: {
        driverId,
        status: { in: ['ASSIGNED', 'ARRIVING', 'IN_PROGRESS'] }
      },
      orderBy: { createdAt: 'desc' },
      include: {
        rider: { select: { id: true, name: true, phone: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 20 }
      }
    })
  ])

  return res.json({
    isOnline: Boolean(location && (location.isAvailable || ride)),
    location: location ? { lat: location.lat, lng: location.lng, updatedAt: location.updatedAt } : null,
    ride: ride ?? null
  })
})

router.get('/:id/earnings', async (req, res) => {
  const driverId = req.params.id
  const period = String(req.query.period ?? 'today')
  const now = new Date()

  const start = new Date(now)
  if (period === 'week') start.setDate(start.getDate() - 7)
  else if (period === 'month') start.setMonth(start.getMonth() - 1)
  else start.setHours(0, 0, 0, 0)

  const rides = await prisma.ride.findMany({
    where: {
      driverId,
      status: 'COMPLETED',
      updatedAt: { gte: start }
    },
    orderBy: { updatedAt: 'desc' },
    take: 100
  })

  const rideIds = rides.map((ride) => ride.id)
  const ratingEvents = rideIds.length
    ? await prisma.rideEvent.findMany({
      where: { rideId: { in: rideIds }, type: 'RATED' },
      select: { metadata: true }
    })
    : []

  const ratings = ratingEvents
    .map((event) => {
      const rating = (event.metadata as { rating?: unknown } | null)?.rating
      return typeof rating === 'number' ? rating : null
    })
    .filter((value): value is number => typeof value === 'number')

  const totalEarnings = rides.reduce((sum, ride) => sum + ride.fareAmount, 0)
  const onlineHours = rides.reduce((sum, ride) => {
    const hours = (ride.updatedAt.getTime() - ride.createdAt.getTime()) / 3_600_000
    return sum + Math.max(0, Math.min(hours, 4))
  }, 0)

  const recentTrips = rides.slice(0, 10).map((ride) => ({
    id: ride.id,
    from: ride.pickupAddress.split(',')[0]?.trim() || ride.pickupAddress,
    to: ride.dropoffAddress.split(',')[0]?.trim() || ride.dropoffAddress,
    date: ride.updatedAt.toISOString(),
    distanceKm: Number(haversine(ride.pickupLat, ride.pickupLng, ride.dropoffLat, ride.dropoffLng).toFixed(2)),
    fare: ride.fareAmount
  }))

  return res.json({
    period,
    totalEarnings: Number(totalEarnings.toFixed(2)),
    totalTrips: rides.length,
    totalHours: Number(onlineHours.toFixed(1)),
    avgRating: ratings.length ? Number((ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(2)) : null,
    recentTrips
  })
})

export default router
