import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import adminRoutes from './admin'
import { signAuthToken } from '../lib/auth'

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', adminRoutes)
  return app
}

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
