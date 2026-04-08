import prisma from '../db'

export type FareBreakdown = {
  base: number
  distance: number
  time: number
}

export type FareCalculationResult = {
  currency: string
  total: number
  distanceKm: number
  durationMin: number
  breakdown: FareBreakdown
}

export async function getOrCreateFareConfig() {
  return prisma.fareConfig.upsert({
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
}

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

export async function calculateFare(pickupLat: number, pickupLng: number, dropoffLat: number, dropoffLng: number): Promise<FareCalculationResult> {
  const config = await getOrCreateFareConfig()
  const distanceKm = haversine(pickupLat, pickupLng, dropoffLat, dropoffLng)
  const durationMin = Math.max(4, (distanceKm / 22) * 60)

  const breakdown = {
    base: config.baseFare,
    distance: Math.round(distanceKm * config.perKmRate),
    time: Math.round(durationMin * config.perMinuteRate)
  }

  const rawTotal = breakdown.base + breakdown.distance + breakdown.time
  const total = Math.max(config.minimumFare, rawTotal)

  return {
    currency: config.currency,
    total: Number(total.toFixed(2)),
    distanceKm: Number(distanceKm.toFixed(2)),
    durationMin: Math.round(durationMin),
    breakdown
  }
}
