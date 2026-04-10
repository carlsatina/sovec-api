import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import ridesRoutes from './rides.js'
import { signAuthToken } from '../lib/auth.js'
import prisma from '../db.js'

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/rides', ridesRoutes)
  return app
}

const originalPrisma = {
  ride: (prisma as any).ride,
  supportTicket: (prisma as any).supportTicket,
  rideEvent: (prisma as any).rideEvent,
  $transaction: (prisma as any).$transaction
}

afterEach(() => {
  ;(prisma as any).ride = originalPrisma.ride
  ;(prisma as any).supportTicket = originalPrisma.supportTicket
  ;(prisma as any).rideEvent = originalPrisma.rideEvent
  ;(prisma as any).$transaction = originalPrisma.$transaction
})

test('POST /rides/:id/sos requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).post('/rides/ride-1/sos').send({ severity: 'HIGH' })
  assert.equal(res.status, 401)
})

test('POST /rides/:id/sos blocks non-participant', async () => {
  const app = createTestApp()
  const token = signAuthToken({ userId: 'other-user', phone: '+639170000001', role: 'PASSENGER' })

  ;(prisma as any).ride = {
    findUnique: async () => ({
      id: 'ride-1',
      riderId: 'rider-1',
      driverId: 'driver-1',
      status: 'IN_PROGRESS'
    })
  }

  const res = await request(app)
    .post('/rides/ride-1/sos')
    .set('Authorization', `Bearer ${token}`)
    .send({ severity: 'HIGH' })

  assert.equal(res.status, 403)
})

test('POST /rides/:id/sos creates incident for active ride participant', async () => {
  const app = createTestApp()
  const token = signAuthToken({ userId: 'rider-1', phone: '+639170000002', role: 'PASSENGER' })

  ;(prisma as any).ride = {
    findUnique: async () => ({
      id: 'ride-1',
      riderId: 'rider-1',
      driverId: 'driver-1',
      status: 'IN_PROGRESS'
    })
  }
  ;(prisma as any).supportTicket = {
    create: async () => ({ id: 'inc-1', status: 'OPEN' })
  }
  ;(prisma as any).rideEvent = {
    create: async () => ({ id: 'evt-1' })
  }
  ;(prisma as any).$transaction = async (fn: any) => fn({
    supportTicket: {
      create: async () => ({ id: 'inc-1', status: 'OPEN' })
    },
    rideEvent: {
      create: async () => ({ id: 'evt-1' })
    }
  })

  const res = await request(app)
    .post('/rides/ride-1/sos')
    .set('Authorization', `Bearer ${token}`)
    .send({ severity: 'CRITICAL', note: 'Unsafe behavior observed' })

  assert.equal(res.status, 201)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.incidentId, 'inc-1')
  assert.equal(res.body.rideEventId, 'evt-1')
})
