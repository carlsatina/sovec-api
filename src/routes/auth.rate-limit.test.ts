import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import authRoutes from './auth.js'
import { resetAuthStateForTests } from '../lib/auth.js'

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/auth', authRoutes)
  return app
}

function isTransientTransportError(err: unknown) {
  const code = (err as { code?: string } | undefined)?.code
  return code === 'HPE_INVALID_CONSTANT' || code === 'ECONNRESET'
}

async function postOtpSendWithIp(app: ReturnType<typeof createTestApp>, phone: string, ip: string) {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request(app)
        .post('/auth/otp/send')
        .set('X-Forwarded-For', ip)
        .send({ phone })
    } catch (err) {
      if (!isTransientTransportError(err) || attempt === 2) throw err
      lastError = err
    }
  }
  throw lastError
}

async function triggerVerifyLock(app: ReturnType<typeof createTestApp>, phone: string) {
  for (let i = 0; i < 12; i += 1) {
    const res = await request(app).post('/auth/otp/verify').send({ phone, code: '000000' })
    if (res.status === 429) return res
    assert.equal(res.status, 401)
  }
  throw new Error('Expected verify lock (429) was not reached')
}

test.beforeEach(() => {
  process.env.SMS_PROVIDER = 'mock'
  resetAuthStateForTests()
})

test.afterEach(() => {
  resetAuthStateForTests()
})

test('POST /auth/otp/send returns 429 after too many requests', async () => {
  const app = createTestApp()
  const phone = `+63917${String(Math.floor(Math.random() * 1_000_0000)).padStart(7, '0')}`

  for (let i = 0; i < 5; i += 1) {
    const res = await request(app).post('/auth/otp/send').send({ phone })
    assert.equal(res.status, 200)
  }

  const blocked = await request(app).post('/auth/otp/send').send({ phone })
  assert.equal(blocked.status, 429)
  assert.equal(typeof blocked.body.retryAfterSec, 'number')
  assert.ok(blocked.body.retryAfterSec >= 1)
  assert.equal(blocked.headers['retry-after'] !== undefined, true)
})

test('POST /auth/otp/verify returns 429 after repeated failed attempts', async () => {
  const app = createTestApp()
  const phone = `+63918${String(Math.floor(Math.random() * 1_000_0000)).padStart(7, '0')}`

  const send = await request(app).post('/auth/otp/send').send({ phone })
  assert.equal(send.status, 200)

  const blocked = await triggerVerifyLock(app, phone)
  assert.equal(typeof blocked.body.retryAfterSec, 'number')
  assert.ok(blocked.body.retryAfterSec >= 1)
  assert.equal(blocked.headers['retry-after'] !== undefined, true)
})

test('POST /auth/otp/verify lock expires and stops returning 429', async () => {
  const app = createTestApp()
  const phone = `+63919${String(Math.floor(Math.random() * 1_000_0000)).padStart(7, '0')}`

  const send = await request(app).post('/auth/otp/send').send({ phone })
  assert.equal(send.status, 200)

  const blocked = await triggerVerifyLock(app, phone)
  assert.equal(blocked.status, 429)

  const realNow = Date.now
  const elevenMinutes = 11 * 60 * 1000
  Date.now = () => realNow() + elevenMinutes
  try {
    const afterExpiry = await request(app).post('/auth/otp/verify').send({ phone, code: '000000' })
    assert.equal(afterExpiry.status, 401)
  } finally {
    Date.now = realNow
  }
})

test('POST /auth/otp/send enforces IP-based limit across different phone numbers', async () => {
  const app = createTestApp()
  const ip = '10.20.30.40'

  for (let i = 0; i < 5; i += 1) {
    const phone = `+63915${String(1000000 + i)}`
    const res = await postOtpSendWithIp(app, phone, ip)
    assert.equal(res.status, 200)
  }

  const blocked = await postOtpSendWithIp(app, '+639151234567', ip)

  assert.equal(blocked.status, 429)
  assert.equal(typeof blocked.body.retryAfterSec, 'number')
  assert.ok(blocked.body.retryAfterSec >= 1)
})

test('POST /auth/otp/send retry-after decreases as time moves forward', async () => {
  const app = createTestApp()
  const phone = `+63916${String(Math.floor(Math.random() * 1_000_0000)).padStart(7, '0')}`
  for (let i = 0; i < 5; i += 1) {
    const res = await request(app).post('/auth/otp/send').send({ phone })
    assert.equal(res.status, 200)
  }

  const blocked1 = await request(app).post('/auth/otp/send').send({ phone })
  assert.equal(blocked1.status, 429)
  const retry1 = Number(blocked1.headers['retry-after'])
  assert.ok(Number.isFinite(retry1))
  assert.ok(retry1 >= 1)

  await new Promise((resolve) => setTimeout(resolve, 1_100))

  const blocked2 = await request(app).post('/auth/otp/send').send({ phone })
  assert.equal(blocked2.status, 429)
  const retry2 = Number(blocked2.headers['retry-after'])
  assert.ok(Number.isFinite(retry2))
  assert.ok(retry2 <= retry1)
  assert.ok(retry2 >= 1)
})
