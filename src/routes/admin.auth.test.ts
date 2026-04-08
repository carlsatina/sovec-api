import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import adminRoutes from './admin'
import { signAuthToken } from '../lib/auth'
import prisma from '../db'

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', adminRoutes)
  return app
}

const originalPrisma = {
  ride: (prisma as any).ride,
  driverApplication: (prisma as any).driverApplication,
  user: (prisma as any).user,
  vehicle: (prisma as any).vehicle,
  $transaction: (prisma as any).$transaction
}

afterEach(() => {
  ;(prisma as any).ride = originalPrisma.ride
  ;(prisma as any).driverApplication = originalPrisma.driverApplication
  ;(prisma as any).user = originalPrisma.user
  ;(prisma as any).vehicle = originalPrisma.vehicle
  ;(prisma as any).$transaction = originalPrisma.$transaction
})

test('GET /admin/driver-applications requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/driver-applications')
  assert.equal(res.status, 401)
})

test('GET /admin/driver-applications requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-passenger',
    phone: '+639171111111',
    role: 'PASSENGER'
  })

  const res = await request(app)
    .get('/admin/driver-applications')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 403)
})

test('GET /admin/rides requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/rides')
  assert.equal(res.status, 401)
})

test('GET /admin/rides requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-driver',
    phone: '+639172222222',
    role: 'DRIVER'
  })

  const res = await request(app)
    .get('/admin/rides')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 403)
})

test('GET /admin/pricing requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/pricing')
  assert.equal(res.status, 401)
})

test('GET /admin/pricing requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-passenger',
    phone: '+639171111111',
    role: 'PASSENGER'
  })

  const res = await request(app)
    .get('/admin/pricing')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 403)
})

test('GET /admin/vehicles requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/vehicles')
  assert.equal(res.status, 401)
})

test('GET /admin/drivers/available requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/drivers/available')
  assert.equal(res.status, 401)
})

test('GET /admin/rides applies activeOnly=false correctly', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  let capturedWhere: unknown = null
  ;(prisma as any).ride = {
    findMany: async (args: any) => {
      capturedWhere = args.where
      return []
    },
    count: async () => 0
  }

  const res = await request(app)
    .get('/admin/rides?activeOnly=false&page=1&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.deepEqual(capturedWhere, {})
  assert.equal(res.body.total, 0)
})

test('POST /admin/rides/:id/force-cancel returns 409 when ride already transitioned', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).ride = {
    findUnique: async () => ({ id: 'ride-1', riderId: 'rider-1', driverId: null, status: 'ASSIGNED' })
  }
  ;(prisma as any).$transaction = async (fn: any) => fn({
    ride: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ id: 'ride-1', status: 'COMPLETED' })
    },
    rideEvent: {
      create: async () => ({})
    }
  })

  const res = await request(app)
    .post('/admin/rides/ride-1/force-cancel')
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'ops cancel' })

  assert.equal(res.status, 409)
  assert.match(res.body.error, /already completed/i)
})

test('POST /admin/rides/:id/reassign returns 409 when ride state changes concurrently', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).ride = {
    findUnique: async () => ({ id: 'ride-1', riderId: 'rider-1', driverId: 'driver-1', status: 'ASSIGNED' })
  }
  ;(prisma as any).$transaction = async (fn: any) => fn({
    ride: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ id: 'ride-1', status: 'IN_PROGRESS' })
    },
    rideEvent: {
      create: async () => ({})
    }
  })

  const res = await request(app)
    .post('/admin/rides/ride-1/reassign')
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'reassign attempt' })

  assert.equal(res.status, 409)
  assert.match(res.body.error, /IN_PROGRESS/i)
})

test('POST /admin/driver-applications/:id/status promotes approved passenger to DRIVER role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).driverApplication = {
    findUnique: async () => ({ id: 'app-1', userId: 'user-1', status: 'UNDER_REVIEW', notes: null })
  }

  let userUpdateManyCalls = 0
  ;(prisma as any).$transaction = async (fn: any) => fn({
    driverApplication: {
      update: async () => ({ id: 'app-1', status: 'APPROVED' })
    },
    user: {
      updateMany: async (args: any) => {
        userUpdateManyCalls += 1
        assert.deepEqual(args.where, { id: 'user-1', role: 'PASSENGER' })
        assert.deepEqual(args.data, { role: 'DRIVER' })
        return { count: 1 }
      }
    }
  })

  const res = await request(app)
    .post('/admin/driver-applications/app-1/status')
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'APPROVED' })

  assert.equal(res.status, 200)
  assert.equal(userUpdateManyCalls, 1)
})

test('POST /admin/vehicles rejects non-driver assignment', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'user-1', role: 'PASSENGER' })
  }

  const res = await request(app)
    .post('/admin/vehicles')
    .set('Authorization', `Bearer ${token}`)
    .send({
      plateNumber: 'ABC1234',
      model: 'BYD Dolphin',
      capacity: 4,
      driverId: 'user-1'
    })

  assert.equal(res.status, 422)
  assert.match(res.body.error, /DRIVER role/i)
})

test('POST /admin/vehicles/:id/assign-driver returns conflict when driver already has vehicle', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).vehicle = {
    findUnique: async () => ({ id: 'vehicle-1', driverId: null }),
    findFirst: async () => ({ id: 'vehicle-2' })
  }
  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'driver-1', role: 'DRIVER' })
  }

  const res = await request(app)
    .post('/admin/vehicles/vehicle-1/assign-driver')
    .set('Authorization', `Bearer ${token}`)
    .send({ driverId: 'driver-1' })

  assert.equal(res.status, 409)
  assert.match(res.body.error, /already has an assigned vehicle/i)
})

test('POST /admin/vehicles/:id/status returns 404 when vehicle is missing', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).vehicle = {
    findUnique: async () => null
  }

  const res = await request(app)
    .post('/admin/vehicles/unknown/status')
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'CHARGING' })

  assert.equal(res.status, 404)
})

test('GET /admin/drivers/available applies default filters (available + unassigned)', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  let capturedWhere: unknown = null
  ;(prisma as any).user = {
    findMany: async (args: any) => {
      capturedWhere = args.where
      return []
    },
    count: async () => 0
  }

  const res = await request(app)
    .get('/admin/drivers/available?page=1&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.deepEqual(capturedWhere, {
    role: 'DRIVER',
    driverLocation: { is: { isAvailable: true } },
    vehicle: { is: null }
  })
})

test('GET /admin/drivers/available allows disabling default filters', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  let capturedWhere: unknown = null
  ;(prisma as any).user = {
    findMany: async (args: any) => {
      capturedWhere = args.where
      return []
    },
    count: async () => 0
  }

  const res = await request(app)
    .get('/admin/drivers/available?availableOnly=false&unassignedOnly=false&page=1&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.deepEqual(capturedWhere, {
    role: 'DRIVER'
  })
})
