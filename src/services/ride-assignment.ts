import prisma from '../db'
import { getIo } from '../socket'

const ASSIGNMENT_TIMEOUT_MS = 30_000
const assignmentTimers = new Map<string, ReturnType<typeof setTimeout>>()

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

export function clearAssignmentTimeout(rideId: string) {
  const timer = assignmentTimers.get(rideId)
  if (!timer) return
  clearTimeout(timer)
  assignmentTimers.delete(rideId)
}

function scheduleAssignmentTimeout(rideId: string, excludedDriverIds: string[] = [], delayMs = ASSIGNMENT_TIMEOUT_MS) {
  clearAssignmentTimeout(rideId)
  const timer = setTimeout(() => {
    reassignRide(rideId, excludedDriverIds).catch(() => null)
  }, delayMs)
  assignmentTimers.set(rideId, timer)
}

async function findNearestAvailableDriver(
  pickupLat: number,
  pickupLng: number,
  excludedDriverIds: string[] = []
) {
  const locations = await prisma.driverLocation.findMany({
    where: { isAvailable: true, driverId: { notIn: excludedDriverIds } },
    select: { driverId: true, lat: true, lng: true }
  })

  if (!locations.length) return null

  const scored = locations.map((loc) => ({
    driverId: loc.driverId,
    distance: haversine(pickupLat, pickupLng, loc.lat, loc.lng)
  }))
  scored.sort((a, b) => a.distance - b.distance)
  return scored[0].driverId
}

export async function tryAssignRide(rideId: string, excludedDriverIds: string[] = []) {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { id: true, riderId: true, pickupLat: true, pickupLng: true, status: true }
  })

  if (!ride || !['FINDING_DRIVER', 'ASSIGNED'].includes(ride.status)) return null

  const driverId = await findNearestAvailableDriver(ride.pickupLat, ride.pickupLng, excludedDriverIds)
  if (!driverId) return null

  const updated = await prisma.ride.update({
    where: { id: ride.id },
    data: {
      driverId,
      status: 'ASSIGNED',
      events: { create: [{ type: 'ASSIGNED' }] }
    }
  })

  await prisma.driverLocation.update({
    where: { driverId },
    data: { isAvailable: false }
  })

  const io = getIo()
  io.to(`ride:${updated.id}`).emit('ride:status', { rideId: updated.id, status: updated.status, driverId })
  io.to(`user:${ride.riderId}`).emit('ride:status', { rideId: updated.id, status: updated.status, driverId })
  io.to(`user:${driverId}`).emit('ride:status', { rideId: updated.id, status: updated.status, riderId: ride.riderId })

  scheduleAssignmentTimeout(updated.id, [...new Set([...excludedDriverIds, driverId])])
  return updated
}

export async function reassignRide(rideId: string, excludedDriverIds: string[] = []) {
  clearAssignmentTimeout(rideId)

  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: {
      id: true,
      riderId: true,
      driverId: true,
      status: true
    }
  })

  if (!ride || ride.status !== 'ASSIGNED') return

  const previousDriverId = ride.driverId ?? null
  if (previousDriverId) {
    await prisma.driverLocation.update({
      where: { driverId: previousDriverId },
      data: { isAvailable: true }
    }).catch(() => null)
  }

  const nextExcludedDriverIds = [
    ...excludedDriverIds,
    ...(previousDriverId ? [previousDriverId] : [])
  ]
  const reassigned = await tryAssignRide(ride.id, nextExcludedDriverIds)
  if (reassigned) return

  const finding = await prisma.ride.update({
    where: { id: ride.id },
    data: {
      driverId: null,
      status: 'FINDING_DRIVER',
      events: { create: [{ type: 'FINDING_DRIVER' }] }
    }
  })

  const io = getIo()
  io.to(`ride:${finding.id}`).emit('ride:status', { rideId: finding.id, status: finding.status })
  io.to(`user:${ride.riderId}`).emit('ride:status', { rideId: finding.id, status: finding.status })
}

export async function bootstrapAssignmentTimeouts() {
  const assignedRides = await prisma.ride.findMany({
    where: { status: 'ASSIGNED' },
    select: { id: true, updatedAt: true }
  })

  const now = Date.now()
  for (const ride of assignedRides) {
    const elapsedMs = now - ride.updatedAt.getTime()
    if (elapsedMs >= ASSIGNMENT_TIMEOUT_MS) {
      reassignRide(ride.id).catch(() => null)
      continue
    }
    const delayMs = Math.max(1_000, ASSIGNMENT_TIMEOUT_MS - elapsedMs)
    scheduleAssignmentTimeout(ride.id, [], delayMs)
  }
}
