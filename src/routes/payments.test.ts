import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import paymentRoutes from './payments.js'
import { signAuthToken } from '../lib/auth.js'
import prisma from '../db.js'

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/payments', paymentRoutes)
  return app
}

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  PAYMENT_WEBHOOK_SECRET: process.env.PAYMENT_WEBHOOK_SECRET,
  PAYMENT_PROVIDER: process.env.PAYMENT_PROVIDER,
  PAYMONGO_WEBHOOK_SECRET: process.env.PAYMONGO_WEBHOOK_SECRET
}

const originalPrisma = {
  ride: (prisma as any).ride,
  payment: (prisma as any).payment,
  rideEvent: (prisma as any).rideEvent,
  $transaction: (prisma as any).$transaction
}

afterEach(() => {
  process.env.NODE_ENV = originalEnv.NODE_ENV
  process.env.PAYMENT_WEBHOOK_SECRET = originalEnv.PAYMENT_WEBHOOK_SECRET
  process.env.PAYMENT_PROVIDER = originalEnv.PAYMENT_PROVIDER
  process.env.PAYMONGO_WEBHOOK_SECRET = originalEnv.PAYMONGO_WEBHOOK_SECRET
  ;(prisma as any).ride = originalPrisma.ride
  ;(prisma as any).payment = originalPrisma.payment
  ;(prisma as any).rideEvent = originalPrisma.rideEvent
  ;(prisma as any).$transaction = originalPrisma.$transaction
})

test('POST /payments/charge requires auth token', async () => {
  const app = createTestApp()
  const res = await request(app).post('/payments/charge').send({ rideId: 'ride-1' })
  assert.equal(res.status, 401)
})

test('POST /payments/charge rejects non-rider', async () => {
  const app = createTestApp()
  const token = signAuthToken({ userId: 'user-2', phone: '+639170000002', role: 'PASSENGER' })

  ;(prisma as any).ride = {
    findUnique: async () => ({
      id: 'ride-1',
      riderId: 'user-1',
      fareAmount: 220,
      currency: 'PHP',
      paymentMethod: 'EWALLET'
    })
  }

  const res = await request(app)
    .post('/payments/charge')
    .set('Authorization', `Bearer ${token}`)
    .send({ rideId: 'ride-1' })

  assert.equal(res.status, 403)
  assert.equal(res.body.error, 'You can only charge your own ride')
})

test('POST /payments/charge upserts payment and returns provider reference', async () => {
  const app = createTestApp()
  const token = signAuthToken({ userId: 'user-1', phone: '+639170000001', role: 'PASSENGER' })

  const updates: Array<{ where: unknown, data: unknown }> = []
  const events: Array<{ data: unknown }> = []

  ;(prisma as any).ride = {
    findUnique: async () => ({
      id: 'ride-1',
      riderId: 'user-1',
      fareAmount: 220,
      currency: 'PHP',
      paymentMethod: 'EWALLET'
    })
  }
  ;(prisma as any).payment = {
    findUnique: async () => null,
    upsert: async () => ({
      id: 'pay-1',
      rideId: 'ride-1',
      method: 'EWALLET',
      amount: 220,
      status: 'PENDING',
      reference: null
    }),
    update: async (args: { where: unknown, data: unknown }) => {
      updates.push(args)
      return {
        id: 'pay-1',
        rideId: 'ride-1',
        method: 'EWALLET',
        amount: 220,
        status: 'PENDING',
        reference: 'mock_pay-1'
      }
    }
  }
  ;(prisma as any).rideEvent = {
    create: async (args: { data: unknown }) => {
      events.push(args)
      return { id: 'evt-1' }
    }
  }

  const res = await request(app)
    .post('/payments/charge')
    .set('Authorization', `Bearer ${token}`)
    .send({ rideId: 'ride-1' })

  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.payment.id, 'pay-1')
  assert.equal(res.body.payment.reference, 'mock_pay-1')
  assert.equal(res.body.provider, 'mock')
  assert.equal(typeof res.body.checkoutUrl, 'string')
  assert.equal(updates.length, 1)
  assert.equal(events.length, 1)
})

test('POST /payments/charge blocks re-charge when payment is already settled', async () => {
  const app = createTestApp()
  const token = signAuthToken({ userId: 'user-1', phone: '+639170000001', role: 'PASSENGER' })

  ;(prisma as any).ride = {
    findUnique: async () => ({
      id: 'ride-1',
      riderId: 'user-1',
      fareAmount: 220,
      currency: 'PHP',
      paymentMethod: 'EWALLET'
    })
  }
  ;(prisma as any).payment = {
    findUnique: async () => ({
      id: 'pay-1',
      status: 'VERIFIED',
      reference: 'mock_pay-1'
    }),
    upsert: async () => {
      throw new Error('upsert should not be called')
    }
  }

  const res = await request(app)
    .post('/payments/charge')
    .set('Authorization', `Bearer ${token}`)
    .send({ rideId: 'ride-1' })

  assert.equal(res.status, 409)
  assert.match(res.body.error, /Cannot create new charge/i)
  assert.equal(res.body.status, 'VERIFIED')
})

test('POST /payments/webhooks/mock validates secret when configured', async () => {
  process.env.NODE_ENV = 'production'
  process.env.PAYMENT_WEBHOOK_SECRET = 'phase4-secret'
  const app = createTestApp()

  const res = await request(app)
    .post('/payments/webhooks/mock')
    .send({
      eventId: 'evt-1',
      reference: 'mock_pay-1',
      status: 'PAID'
    })

  assert.equal(res.status, 401)
  assert.equal(res.body.error, 'Webhook authorization failed')
})

test('POST /payments/webhooks/mock updates payment status and is idempotent', async () => {
  process.env.NODE_ENV = 'production'
  process.env.PAYMENT_WEBHOOK_SECRET = 'phase4-secret'
  const app = createTestApp()

  const updates: Array<{ where: unknown, data: unknown }> = []
  const events: Array<{ data: unknown }> = []
  let currentStatus = 'PENDING'

  const tx = {
    payment: {
      update: async (args: { where: unknown, data: { status: string } }) => {
        updates.push(args)
        currentStatus = args.data.status
        return { id: 'pay-1', status: args.data.status }
      }
    },
    rideEvent: {
      create: async (args: { data: unknown }) => {
        events.push(args)
        return { id: 'evt-2' }
      }
    }
  }
  ;(prisma as any).payment = {
    findFirst: async () => ({
      id: 'pay-1',
      rideId: 'ride-1',
      status: currentStatus,
      reference: 'mock_pay-1'
    })
  }
  ;(prisma as any).$transaction = async (fn: (arg: typeof tx) => unknown) => fn(tx)

  const first = await request(app)
    .post('/payments/webhooks/mock')
    .set('x-payment-webhook-secret', 'phase4-secret')
    .send({
      eventId: 'evt-1',
      reference: 'mock_pay-1',
      status: 'PAID'
    })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.applied, true)
  assert.equal(first.body.status, 'PAID')
  assert.equal(updates.length, 1)
  assert.equal(events.length, 1)

  const second = await request(app)
    .post('/payments/webhooks/mock')
    .set('x-payment-webhook-secret', 'phase4-secret')
    .send({
      eventId: 'evt-2',
      reference: 'mock_pay-1',
      status: 'PAID'
    })
  assert.equal(second.status, 200)
  assert.equal(second.body.ok, true)
  assert.equal(second.body.applied, false)
  assert.equal(second.body.reason, 'already_in_state')
  assert.equal(updates.length, 1)
  assert.equal(events.length, 1)
})

test('POST /payments/webhooks/mock rejects invalid transition', async () => {
  process.env.NODE_ENV = 'production'
  process.env.PAYMENT_WEBHOOK_SECRET = 'phase4-secret'
  const app = createTestApp()

  const updates: Array<{ where: unknown, data: unknown }> = []
  const tx = {
    payment: {
      update: async (args: { where: unknown, data: { status: string } }) => {
        updates.push(args)
        return { id: 'pay-1', status: args.data.status }
      }
    },
    rideEvent: {
      create: async () => ({ id: 'evt-2' })
    }
  }
  ;(prisma as any).payment = {
    findFirst: async () => ({
      id: 'pay-1',
      rideId: 'ride-1',
      status: 'REFUND_PENDING',
      reference: 'mock_pay-1'
    })
  }
  ;(prisma as any).$transaction = async (fn: (arg: typeof tx) => unknown) => fn(tx)

  const res = await request(app)
    .post('/payments/webhooks/mock')
    .set('x-payment-webhook-secret', 'phase4-secret')
    .send({
      eventId: 'evt-3',
      reference: 'mock_pay-1',
      status: 'PAID'
    })

  assert.equal(res.status, 409)
  assert.match(res.body.error, /Invalid payment status transition/i)
  assert.equal(updates.length, 0)
})

test('POST /payments/webhooks/paymongo fails closed in production when webhook secret is unset', async () => {
  process.env.NODE_ENV = 'production'
  process.env.PAYMENT_PROVIDER = 'paymongo'
  process.env.PAYMONGO_WEBHOOK_SECRET = ''
  const app = createTestApp()

  const res = await request(app)
    .post('/payments/webhooks/paymongo')
    .set('paymongo-signature', 't=123,te=abc')
    .send({ data: { id: 'evt-1', attributes: { type: 'payment.paid', data: { id: 'paymongo-ref' } } } })

  assert.equal(res.status, 401)
  assert.equal(res.body.error, 'Webhook authorization failed')
})
