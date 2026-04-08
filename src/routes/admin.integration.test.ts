import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import adminRoutes from './admin'
import { signAuthToken } from '../lib/auth'
import prisma from '../db'

function isLikelyTestDatabaseUrl(value: string | undefined) {
  if (!value) return false
  const lower = value.toLowerCase()
  return (
    lower.includes('/test') ||
    lower.includes('_test') ||
    lower.includes('test_') ||
    lower.includes('schema=test') ||
    lower.includes('search_path=test')
  )
}

const shouldRunIntegration = process.env.NODE_ENV === 'test' || isLikelyTestDatabaseUrl(process.env.DATABASE_URL)

function createTestApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', adminRoutes)
  return app
}

after(async () => {
  await prisma.$disconnect()
})

test(
  'integration: approving driver application promotes PASSENGER to DRIVER',
  { skip: !shouldRunIntegration },
  async () => {
    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const passengerPhone = `+63915${Math.floor(1000000 + Math.random() * 8999999)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`

    const admin = await prisma.user.create({
      data: {
        name: `Test Admin ${unique}`,
        phone: adminPhone,
        email: `admin-${unique}@example.com`,
        role: 'ADMIN'
      }
    })

    const passenger = await prisma.user.create({
      data: {
        name: `Test Passenger ${unique}`,
        phone: passengerPhone,
        email: `passenger-${unique}@example.com`,
        role: 'PASSENGER'
      }
    })

    const application = await prisma.driverApplication.create({
      data: {
        userId: passenger.id,
        status: 'UNDER_REVIEW',
        fullName: passenger.name,
        phone: passenger.phone,
        email: passenger.email
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    try {
      const res = await request(app)
        .post(`/admin/driver-applications/${application.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'APPROVED' })

      assert.equal(res.status, 200)
      assert.equal(res.body.application.status, 'APPROVED')

      const updatedPassenger = await prisma.user.findUnique({
        where: { id: passenger.id },
        select: { role: true }
      })
      assert.equal(updatedPassenger?.role, 'DRIVER')
    } finally {
      await prisma.driverApplication.deleteMany({ where: { id: application.id } })
      await prisma.user.deleteMany({ where: { id: { in: [admin.id, passenger.id] } } })
    }
  }
)
