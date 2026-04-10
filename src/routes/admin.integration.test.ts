import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import adminRoutes from './admin.js'
import { signAuthToken } from '../lib/auth.js'
import prisma from '../db.js'

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

async function hasAdminAuditLogTable() {
  const rows = await prisma.$queryRaw<Array<{ table: string | null }>>`
    SELECT to_regclass('"public"."AdminAuditLog"')::text AS table
  `
  return Boolean(rows[0]?.table)
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

test(
  'integration: safety lifecycle writes admin audit logs',
  { skip: !shouldRunIntegration },
  async (t) => {
    if (!(await hasAdminAuditLogTable())) {
      t.skip('AdminAuditLog table is not migrated in this database')
      return
    }

    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`
    const reporterPhone = `+63915${Math.floor(1000000 + Math.random() * 8999999)}`

    const prevEscalationPhones = process.env.SAFETY_ESCALATION_PHONES
    const prevEscalationEmails = process.env.SAFETY_ESCALATION_EMAILS
    const prevWebhook = process.env.SAFETY_ESCALATION_WEBHOOK_URL
    process.env.SAFETY_ESCALATION_PHONES = ''
    process.env.SAFETY_ESCALATION_EMAILS = ''
    delete process.env.SAFETY_ESCALATION_WEBHOOK_URL

    const admin = await prisma.user.create({
      data: {
        name: `Safety Admin ${unique}`,
        phone: adminPhone,
        email: `safety-admin-${unique}@example.com`,
        role: 'ADMIN'
      }
    })

    const reporter = await prisma.user.create({
      data: {
        name: `Safety Reporter ${unique}`,
        phone: reporterPhone,
        email: `safety-reporter-${unique}@example.com`,
        role: 'PASSENGER'
      }
    })

    const incident = await prisma.supportTicket.create({
      data: {
        userId: reporter.id,
        category: 'SOS',
        description: 'Passenger reported unsafe behavior',
        status: 'OPEN'
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    try {
      const acknowledgeRes = await request(app)
        .post(`/admin/safety/incidents/${incident.id}/acknowledge`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 'Acknowledged by operations' })
      assert.equal(acknowledgeRes.status, 200)

      const assignRes = await request(app)
        .post(`/admin/safety/incidents/${incident.id}/assign`)
        .set('Authorization', `Bearer ${token}`)
        .send({ assigneeId: admin.id, note: 'Assigned to duty lead' })
      assert.equal(assignRes.status, 200)

      const escalateRes = await request(app)
        .post(`/admin/safety/incidents/${incident.id}/escalate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priority: 'CRITICAL', reason: 'Immediate intervention required' })
      assert.equal(escalateRes.status, 200)

      const resolveRes = await request(app)
        .post(`/admin/safety/incidents/${incident.id}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'RESOLVED', action: 'Driver removed from current assignment', note: 'Reporter informed' })
      assert.equal(resolveRes.status, 200)

      const logs = await (prisma as any).adminAuditLog.findMany({
        where: {
          adminId: admin.id,
          targetType: 'SAFETY_INCIDENT',
          targetId: incident.id,
          action: { in: ['SAFETY_ACKNOWLEDGE', 'SAFETY_ASSIGN', 'SAFETY_ESCALATE', 'SAFETY_RESOLVE'] }
        },
        select: { action: true }
      })

      const actions = new Set(logs.map((row: { action: string }) => row.action))
      assert.equal(actions.has('SAFETY_ACKNOWLEDGE'), true)
      assert.equal(actions.has('SAFETY_ASSIGN'), true)
      assert.equal(actions.has('SAFETY_ESCALATE'), true)
      assert.equal(actions.has('SAFETY_RESOLVE'), true)
      assert.equal(logs.length >= 4, true)
    } finally {
      await (prisma as any).adminAuditLog.deleteMany({
        where: {
          OR: [
            { adminId: admin.id },
            { targetId: incident.id }
          ]
        }
      }).catch(() => {})
      await (prisma as any).safetyDeliveryLog.deleteMany({
        where: { incidentId: incident.id }
      }).catch(() => {})
      await prisma.notification.deleteMany({
        where: { userId: reporter.id }
      })
      await prisma.supportTicket.deleteMany({
        where: { id: incident.id }
      })
      await prisma.user.deleteMany({ where: { id: { in: [admin.id, reporter.id] } } })

      process.env.SAFETY_ESCALATION_PHONES = prevEscalationPhones
      process.env.SAFETY_ESCALATION_EMAILS = prevEscalationEmails
      if (typeof prevWebhook === 'string') {
        process.env.SAFETY_ESCALATION_WEBHOOK_URL = prevWebhook
      } else {
        delete process.env.SAFETY_ESCALATION_WEBHOOK_URL
      }
    }
  }
)

test(
  'integration: create vehicle rejects invalid state payloads',
  { skip: !shouldRunIntegration },
  async () => {
    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`

    const admin = await prisma.user.create({
      data: {
        name: `Fleet Admin ${unique}`,
        phone: adminPhone,
        email: `fleet-admin-${unique}@example.com`,
        role: 'ADMIN'
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    const inUsePlate = `IT-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
    const chargingPlate = `CH-${Math.random().toString(36).slice(2, 7).toUpperCase()}`

    try {
      const inUseRes = await request(app)
        .post('/admin/vehicles')
        .set('Authorization', `Bearer ${token}`)
        .send({
          plateNumber: inUsePlate,
          model: 'BYD e6',
          capacity: 4,
          batteryCapacityKwh: 71,
          status: 'IN_USE',
          batteryLevel: 80
        })
      assert.equal(inUseRes.status, 422)
      assert.equal(inUseRes.body.error, 'Vehicle must have an assigned driver before setting IN_USE')

      const chargingRes = await request(app)
        .post('/admin/vehicles')
        .set('Authorization', `Bearer ${token}`)
        .send({
          plateNumber: chargingPlate,
          model: 'BYD e6',
          capacity: 4,
          batteryCapacityKwh: 71,
          status: 'CHARGING',
          batteryLevel: 100
        })
      assert.equal(chargingRes.status, 422)
      assert.equal(chargingRes.body.error, 'Battery level must be below 100% when setting CHARGING')
    } finally {
      await prisma.vehicle.deleteMany({
        where: { plateNumber: { in: [inUsePlate, chargingPlate] } }
      })
      await prisma.user.deleteMany({ where: { id: admin.id } })
    }
  }
)
