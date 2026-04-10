import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import adminRoutes from './admin.js'
import { signAuthToken } from '../lib/auth.js'
import prisma from '../db.js'

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', adminRoutes)
  return app
}

const originalPrisma = {
  ride: (prisma as any).ride,
  payment: (prisma as any).payment,
  driverApplication: (prisma as any).driverApplication,
  user: (prisma as any).user,
  vehicle: (prisma as any).vehicle,
  supportTicket: (prisma as any).supportTicket,
  safetyDeliveryLog: (prisma as any).safetyDeliveryLog,
  notification: (prisma as any).notification,
  rideEvent: (prisma as any).rideEvent,
  safetyTemplate: (prisma as any).safetyTemplate,
  $transaction: (prisma as any).$transaction
}

afterEach(() => {
  ;(prisma as any).ride = originalPrisma.ride
  ;(prisma as any).payment = originalPrisma.payment
  ;(prisma as any).driverApplication = originalPrisma.driverApplication
  ;(prisma as any).user = originalPrisma.user
  ;(prisma as any).vehicle = originalPrisma.vehicle
  ;(prisma as any).supportTicket = originalPrisma.supportTicket
  ;(prisma as any).safetyDeliveryLog = originalPrisma.safetyDeliveryLog
  ;(prisma as any).notification = originalPrisma.notification
  ;(prisma as any).rideEvent = originalPrisma.rideEvent
  ;(prisma as any).safetyTemplate = originalPrisma.safetyTemplate
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

test('GET /admin/payments requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/payments')
  assert.equal(res.status, 401)
})

test('GET /admin/payments requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-passenger',
    phone: '+639171111111',
    role: 'PASSENGER'
  })

  const res = await request(app)
    .get('/admin/payments')
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

test('GET /admin/support/tickets requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/support/tickets')
  assert.equal(res.status, 401)
})

test('GET /admin/support/tickets requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-passenger',
    phone: '+639171111111',
    role: 'PASSENGER'
  })

  const res = await request(app)
    .get('/admin/support/tickets')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 403)
})

test('GET /admin/analytics/overview requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/analytics/overview')
  assert.equal(res.status, 401)
})

test('GET /admin/analytics/overview requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-passenger',
    phone: '+639171111111',
    role: 'PASSENGER'
  })

  const res = await request(app)
    .get('/admin/analytics/overview')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 403)
})

test('GET /admin/safety/incidents requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/safety/incidents')
  assert.equal(res.status, 401)
})

test('GET /admin/safety/incidents requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-passenger',
    phone: '+639171111111',
    role: 'PASSENGER'
  })

  const res = await request(app)
    .get('/admin/safety/incidents')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 403)
})

test('GET /admin/safety/templates requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/safety/templates')
  assert.equal(res.status, 401)
})

test('GET /admin/safety/delivery-logs requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).get('/admin/safety/delivery-logs')
  assert.equal(res.status, 401)
})

test('GET /admin/safety/delivery-logs requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-passenger',
    phone: '+639171111111',
    role: 'PASSENGER'
  })

  const res = await request(app)
    .get('/admin/safety/delivery-logs')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 403)
})

test('GET /admin/safety/templates requires ADMIN role', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'user-passenger',
    phone: '+639171111111',
    role: 'PASSENGER'
  })

  const res = await request(app)
    .get('/admin/safety/templates')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 403)
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

test('GET /admin/payments applies filters and returns pagination', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  let capturedWhere: unknown = null
  ;(prisma as any).payment = {
    findMany: async (args: any) => {
      capturedWhere = args.where
      return []
    },
    count: async () => 0
  }

  const res = await request(app)
    .get('/admin/payments?status=PAID&method=EWALLET&q=juan&page=1&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.deepEqual(capturedWhere, {
    status: 'PAID',
    method: 'EWALLET',
    OR: [
      { id: { contains: 'juan', mode: 'insensitive' } },
      { rideId: { contains: 'juan', mode: 'insensitive' } },
      { reference: { contains: 'juan', mode: 'insensitive' } },
      { ride: { rider: { name: { contains: 'juan', mode: 'insensitive' } } } },
      { ride: { rider: { phone: { contains: 'juan', mode: 'insensitive' } } } },
      { ride: { driver: { name: { contains: 'juan', mode: 'insensitive' } } } },
      { ride: { driver: { phone: { contains: 'juan', mode: 'insensitive' } } } }
    ]
  })
})

test('POST /admin/payments/:id/verify blocks refunded payment', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).payment = {
    findUnique: async () => ({ id: 'pay-1', rideId: 'ride-1', status: 'REFUNDED' })
  }

  const res = await request(app)
    .post('/admin/payments/pay-1/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ note: 'checked' })

  assert.equal(res.status, 409)
})

test('POST /admin/payments/:id/refund validates requested amount', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).payment = {
    findUnique: async () => ({ id: 'pay-2', rideId: 'ride-2', status: 'PAID', amount: 150 })
  }

  const res = await request(app)
    .post('/admin/payments/pay-2/refund')
    .set('Authorization', `Bearer ${token}`)
    .send({ reason: 'duplicate charge', amount: 200 })

  assert.equal(res.status, 422)
  assert.match(res.body.error, /cannot exceed/i)
})

test('POST /admin/payments/:id/verify updates payment status', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).payment = {
    findUnique: async () => ({ id: 'pay-3', rideId: 'ride-3', status: 'PAID' })
  }
  ;(prisma as any).$transaction = async (fn: any) => fn({
    payment: {
      update: async () => ({ id: 'pay-3', status: 'VERIFIED' })
    },
    rideEvent: {
      create: async () => ({ id: 'evt-1' })
    }
  })

  const res = await request(app)
    .post('/admin/payments/pay-3/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ note: 'bank transfer checked' })

  assert.equal(res.status, 200)
  assert.equal(res.body.payment.status, 'VERIFIED')
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

test('GET /admin/support/tickets applies filters and pagination', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  let capturedWhere: unknown = null
  ;(prisma as any).supportTicket = {
    findMany: async (args: any) => {
      capturedWhere = args.where
      return []
    },
    count: async () => 0
  }

  const res = await request(app)
    .get('/admin/support/tickets?status=OPEN&category=safety&q=sos&page=1&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.deepEqual(capturedWhere, {
    status: 'OPEN',
    category: { contains: 'safety', mode: 'insensitive' },
    OR: [
      { id: { contains: 'sos', mode: 'insensitive' } },
      { category: { contains: 'sos', mode: 'insensitive' } },
      { description: { contains: 'sos', mode: 'insensitive' } },
      { user: { name: { contains: 'sos', mode: 'insensitive' } } },
      { user: { phone: { contains: 'sos', mode: 'insensitive' } } },
      { user: { email: { contains: 'sos', mode: 'insensitive' } } }
    ]
  })
  assert.equal(res.body.totalPages, 1)
})

test('POST /admin/support/tickets/:id/status updates status and creates notification', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).supportTicket = {
    findUnique: async () => ({ id: 'ticket-1', userId: 'user-1', category: 'SAFETY', status: 'OPEN' })
  }

  let notificationCreateCalls = 0
  ;(prisma as any).$transaction = async (fn: any) => fn({
    supportTicket: {
      update: async () => ({ id: 'ticket-1', status: 'IN_REVIEW' })
    },
    notification: {
      create: async (args: any) => {
        notificationCreateCalls += 1
        assert.equal(args.data.userId, 'user-1')
        assert.equal(args.data.type, 'SUPPORT_UPDATE')
        return { id: 'notif-1' }
      }
    }
  })

  const res = await request(app)
    .post('/admin/support/tickets/ticket-1/status')
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'IN_REVIEW', note: 'Assigned to operations' })

  assert.equal(res.status, 200)
  assert.equal(res.body.ticket.status, 'IN_REVIEW')
  assert.equal(notificationCreateCalls, 1)
})

test('GET /admin/analytics/overview returns computed metrics', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).ride = {
    count: async (args: any) => {
      const status = args?.where?.status
      if (status === 'COMPLETED') return 9
      if (status === 'CANCELLED') return 3
      return 12
    }
  }
  ;(prisma as any).payment = {
    aggregate: async () => ({ _sum: { amount: 3456.78 } })
  }
  ;(prisma as any).user = {
    count: async () => 5
  }

  const res = await request(app)
    .get('/admin/analytics/overview')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.equal(res.body.today.rides, 12)
  assert.equal(res.body.today.revenue, 3456.78)
  assert.equal(res.body.activeDrivers, 5)
  assert.equal(res.body.rolling30d.completionRate, 75)
  assert.equal(res.body.rolling30d.cancellationRate, 25)
})

test('GET /admin/analytics/trends validates days query', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  const res = await request(app)
    .get('/admin/analytics/trends?days=0')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 422)
})

test('GET /admin/analytics/trends returns bucketed trend data', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  const now = new Date('2026-04-10T12:00:00.000Z')
  const yesterday = new Date('2026-04-09T12:00:00.000Z')

  ;(prisma as any).ride = {
    findMany: async () => [
      { createdAt: now, status: 'COMPLETED' },
      { createdAt: now, status: 'CANCELLED' },
      { createdAt: yesterday, status: 'COMPLETED' }
    ]
  }
  ;(prisma as any).payment = {
    findMany: async () => [
      { createdAt: now, amount: 200 },
      { createdAt: yesterday, amount: 150 }
    ]
  }

  const res = await request(app)
    .get('/admin/analytics/trends?days=2')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.equal(res.body.days, 2)
  assert.equal(Array.isArray(res.body.items), true)
  assert.equal(res.body.items.length, 2)
  const totalRevenue = res.body.items.reduce((sum: number, item: any) => sum + Number(item.revenue), 0)
  const totalRides = res.body.items.reduce((sum: number, item: any) => sum + Number(item.rides), 0)
  assert.equal(totalRevenue, 350)
  assert.equal(totalRides, 3)
})

test('GET /admin/safety/incidents applies default active filter', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  let capturedWhere: unknown = null
  ;(prisma as any).supportTicket = {
    findMany: async (args: any) => {
      capturedWhere = args.where
      return []
    },
    count: async () => 0
  }
  ;(prisma as any).rideEvent = {
    findMany: async () => []
  }

  const res = await request(app)
    .get('/admin/safety/incidents?page=1&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.deepEqual(capturedWhere, {
    category: { in: ['SOS', 'SAFETY'] },
    status: { in: ['OPEN', 'IN_REVIEW'] }
  })
})

test('GET /admin/safety/incidents returns incidentMeta/sla/timeline fields', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  const createdAt = new Date('2026-04-10T10:00:00.000Z')
  ;(prisma as any).supportTicket = {
    findMany: async () => [{
      id: 'inc-1',
      userId: 'user-1',
      category: 'SOS',
      description: '[META]{"rideId":"ride-1","priority":"HIGH","assigneeId":"admin-1","acknowledgedAt":"2026-04-10T10:05:00.000Z","resolvedAt":null}\nSOS note',
      status: 'IN_REVIEW',
      createdAt,
      user: { id: 'user-1', name: 'User', phone: '+639170000010', email: null, role: 'PASSENGER' }
    }],
    count: async () => 1
  }
  ;(prisma as any).rideEvent = {
    findMany: async () => [
      { id: 'evt-1', type: 'SOS_TRIGGERED', createdAt, metadata: { incidentId: 'inc-1' } }
    ]
  }

  const res = await request(app)
    .get('/admin/safety/incidents?activeOnly=false&page=1&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.equal(res.body.items[0].incidentMeta.priority, 'HIGH')
  assert.equal(res.body.items[0].incidentMeta.assigneeId, 'admin-1')
  assert.equal(typeof res.body.items[0].sla.ackSeconds, 'number')
  assert.equal(Array.isArray(res.body.items[0].timeline), true)
})

test('GET /admin/safety/incidents post-filters paginate correctly beyond 500 records', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  const now = Date.now()
  const rows = Array.from({ length: 650 }).map((_, idx) => ({
    id: `inc-${String(idx + 1).padStart(4, '0')}`,
    userId: 'user-1',
    category: 'SOS',
    description: '[META]{"priority":"HIGH","assigneeId":"admin-1","acknowledgedAt":null,"resolvedAt":null}\nLarge dataset',
    status: 'OPEN',
    createdAt: new Date(now - idx * 1000),
    user: { id: 'user-1', name: 'User', phone: '+639170000010', email: null, role: 'PASSENGER' }
  }))

  ;(prisma as any).supportTicket = {
    findMany: async ({ skip = 0, take = 20 }: any) => rows.slice(skip, skip + take),
    count: async () => rows.length
  }
  ;(prisma as any).rideEvent = {
    findMany: async () => []
  }

  const res = await request(app)
    .get('/admin/safety/incidents?priority=HIGH&activeOnly=false&page=2&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.equal(res.body.total, 650)
  assert.equal(res.body.totalPages, 33)
  assert.equal(res.body.items.length, 20)
})

test('GET /admin/safety/delivery-logs applies filters and pagination', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  let capturedWhere: unknown = null
  ;(prisma as any).safetyDeliveryLog = {
    findMany: async (args: any) => {
      capturedWhere = args.where
      return []
    },
    count: async () => 0
  }

  const res = await request(app)
    .get('/admin/safety/delivery-logs?status=DEAD_LETTER&channel=email&q=timeout&page=1&limit=20')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.deepEqual(capturedWhere, {
    status: 'DEAD_LETTER',
    channel: 'email',
    OR: [
      { id: { contains: 'timeout', mode: 'insensitive' } },
      { incidentId: { contains: 'timeout', mode: 'insensitive' } },
      { target: { contains: 'timeout', mode: 'insensitive' } },
      { lastError: { contains: 'timeout', mode: 'insensitive' } }
    ]
  })
})

test('POST /admin/safety/delivery-logs/:id/retry retries dead-letter log', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  const prevSmsProvider = process.env.SMS_PROVIDER
  process.env.SMS_PROVIDER = 'mock'

  let createCalls = 0
  ;(prisma as any).safetyDeliveryLog = {
    findUnique: async () => ({
      id: 'dl-1',
      incidentId: 'inc-1',
      event: 'safety.escalated',
      channel: 'sms',
      target: '+639171234567',
      status: 'DEAD_LETTER',
      attempts: 3,
      payload: { message: 'Retry me' }
    }),
    create: async () => {
      createCalls += 1
      return { id: 'dl-2' }
    }
  }

  const res = await request(app)
    .post('/admin/safety/delivery-logs/dl-1/retry')
    .set('Authorization', `Bearer ${token}`)
    .send({})

  process.env.SMS_PROVIDER = prevSmsProvider
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.retry.ok, true)
  assert.equal(createCalls, 1)
})

test('POST /admin/safety/delivery-logs/:id/retry rejects unsupported channel', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).safetyDeliveryLog = {
    findUnique: async () => ({
      id: 'dl-1',
      incidentId: 'inc-1',
      event: 'safety.escalated',
      channel: 'push',
      target: 'device-token',
      status: 'DEAD_LETTER',
      attempts: 3,
      payload: { message: 'Retry me' }
    })
  }

  const res = await request(app)
    .post('/admin/safety/delivery-logs/dl-1/retry')
    .set('Authorization', `Bearer ${token}`)
    .send({})

  assert.equal(res.status, 422)
  assert.match(res.body.error, /Unsupported delivery channel/i)
})

test('POST /admin/safety/incidents/:id/acknowledge updates status to IN_REVIEW', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).supportTicket = {
    findUnique: async () => ({ id: 'inc-1', userId: 'user-1', category: 'SOS', description: null }),
    update: async () => ({ id: 'inc-1', status: 'IN_REVIEW' })
  }
  ;(prisma as any).rideEvent = {
    create: async () => ({ id: 'evt-ack' })
  }

  const res = await request(app)
    .post('/admin/safety/incidents/inc-1/acknowledge')
    .set('Authorization', `Bearer ${token}`)
    .send({ note: 'Investigating now' })

  assert.equal(res.status, 200)
  assert.equal(res.body.incident.status, 'IN_REVIEW')
})

test('POST /admin/safety/incidents/:id/assign defaults assignee to current admin', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).supportTicket = {
    findUnique: async () => ({ id: 'inc-1', userId: 'user-1', category: 'SOS', description: null }),
    update: async () => ({ id: 'inc-1', status: 'IN_REVIEW' })
  }
  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'admin-1', role: 'ADMIN' })
  }
  ;(prisma as any).rideEvent = {
    create: async () => ({ id: 'evt-assign' })
  }

  const res = await request(app)
    .post('/admin/safety/incidents/inc-1/assign')
    .set('Authorization', `Bearer ${token}`)
    .send({})

  assert.equal(res.status, 200)
  assert.equal(res.body.assigneeId, 'admin-1')
})

test('POST /admin/safety/incidents/:id/escalate updates priority', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).supportTicket = {
    findUnique: async () => ({ id: 'inc-1', userId: 'user-1', category: 'SOS', description: null }),
    update: async () => ({ id: 'inc-1', status: 'IN_REVIEW' })
  }
  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'user-1', name: 'Reporter One', phone: '+639170000099', email: null })
  }
  ;(prisma as any).rideEvent = {
    create: async () => ({ id: 'evt-esc' })
  }
  ;(prisma as any).safetyTemplate = {
    upsert: async ({ where, create, update }: any) => ({ key: where.key, ...(Object.keys(update ?? {}).length ? update : create) }),
    findMany: async () => [
      { key: 'ESCALATION_ADMIN', subject: 'Esc {{incidentId}}', body: 'Body {{priority}}' },
      { key: 'ESCALATION_REPORTER', subject: 'Rep {{incidentId}}', body: 'Body {{priority}}' },
      { key: 'RESOLUTION_REPORTER', subject: 'Res {{incidentId}}', body: 'Body {{status}}' }
    ]
  }

  const res = await request(app)
    .post('/admin/safety/incidents/inc-1/escalate')
    .set('Authorization', `Bearer ${token}`)
    .send({ priority: 'CRITICAL', reason: 'Threat to passenger safety' })

  assert.equal(res.status, 200)
  assert.equal(res.body.priority, 'CRITICAL')
})

test('GET /admin/safety/templates returns configured templates', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).safetyTemplate = {
    upsert: async ({ where, create, update }: any) => ({ key: where.key, ...(Object.keys(update ?? {}).length ? update : create) }),
    findMany: async () => [
      { key: 'ESCALATION_ADMIN', subject: 'Safety Escalation {{incidentId}} ({{priority}})', body: 'Body A' },
      { key: 'ESCALATION_REPORTER', subject: 'Your Safety Incident Is Escalated', body: 'Body B' },
      { key: 'RESOLUTION_REPORTER', subject: 'Safety Incident {{incidentId}} Update', body: 'Body C' }
    ]
  }

  const res = await request(app)
    .get('/admin/safety/templates')
    .set('Authorization', `Bearer ${token}`)

  assert.equal(res.status, 200)
  assert.equal(Array.isArray(res.body.items), true)
  const keys = res.body.items.map((item: any) => item.key)
  assert.equal(keys.includes('ESCALATION_ADMIN'), true)
  assert.equal(keys.includes('ESCALATION_REPORTER'), true)
  assert.equal(keys.includes('RESOLUTION_REPORTER'), true)
})

test('PUT /admin/safety/templates/:key updates template', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  const table = new Map<string, { key: string; subject: string; body: string }>([
    ['ESCALATION_ADMIN', { key: 'ESCALATION_ADMIN', subject: 'Old subject', body: 'Old body' }],
    ['ESCALATION_REPORTER', { key: 'ESCALATION_REPORTER', subject: 'Reporter subject', body: 'Reporter body' }],
    ['RESOLUTION_REPORTER', { key: 'RESOLUTION_REPORTER', subject: 'Resolution subject', body: 'Resolution body' }]
  ])
  ;(prisma as any).safetyTemplate = {
    findUnique: async ({ where }: any) => table.get(where.key) ?? null,
    upsert: async ({ where, create, update }: any) => {
      const existing = table.get(where.key)
      const next = existing ? { ...existing, ...update } : { ...create }
      table.set(where.key, next)
      return next
    },
    findMany: async () => Array.from(table.values())
  }

  const updateRes = await request(app)
    .put('/admin/safety/templates/ESCALATION_ADMIN')
    .set('Authorization', `Bearer ${token}`)
    .send({ subject: 'Escalation {{incidentId}} [{{priority}}]' })

  assert.equal(updateRes.status, 200)
  assert.match(updateRes.body.template.subject, /Escalation/)

  const getRes = await request(app)
    .get('/admin/safety/templates')
    .set('Authorization', `Bearer ${token}`)

  const updated = getRes.body.items.find((item: any) => item.key === 'ESCALATION_ADMIN')
  assert.equal(typeof updated?.subject, 'string')
  assert.match(updated.subject, /Escalation/)
})

test('POST /admin/safety/incidents/:id/resolve updates incident and creates notification', async () => {
  const app = createTestApp()
  const token = signAuthToken({
    userId: 'admin-1',
    phone: '+639170000001',
    role: 'ADMIN'
  })

  ;(prisma as any).supportTicket = {
    findUnique: async () => ({ id: 'inc-1', userId: 'user-1', category: 'SOS', status: 'OPEN', description: null })
  }
  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'user-1', name: 'Reporter One', phone: '+639170000099', email: null })
  }
  ;(prisma as any).safetyTemplate = {
    upsert: async ({ where, create, update }: any) => ({ key: where.key, ...(Object.keys(update ?? {}).length ? update : create) }),
    findMany: async () => [
      { key: 'ESCALATION_ADMIN', subject: 'Esc {{incidentId}}', body: 'Body {{priority}}' },
      { key: 'ESCALATION_REPORTER', subject: 'Rep {{incidentId}}', body: 'Body {{priority}}' },
      { key: 'RESOLUTION_REPORTER', subject: 'Res {{incidentId}}', body: 'Body {{status}}' }
    ]
  }

  let notificationCreateCalls = 0
  ;(prisma as any).$transaction = async (fn: any) => fn({
    supportTicket: {
      update: async () => ({ id: 'inc-1', status: 'RESOLVED' })
    },
    notification: {
      create: async (args: any) => {
        notificationCreateCalls += 1
        assert.equal(args.data.userId, 'user-1')
        assert.equal(args.data.type, 'SAFETY_INCIDENT_UPDATE')
        return { id: 'notif-2' }
      }
    }
  })

  const res = await request(app)
    .post('/admin/safety/incidents/inc-1/resolve')
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'RESOLVED', action: 'Warned driver', note: 'Monitoring next trip' })

  assert.equal(res.status, 200)
  assert.equal(res.body.incident.status, 'RESOLVED')
  assert.equal(notificationCreateCalls, 1)
})
