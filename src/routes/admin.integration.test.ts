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
      await (prisma as any).adminAuditLog?.deleteMany?.({
        where: {
          OR: [
            { adminId: admin.id },
            { targetId: application.id }
          ]
        }
      }).catch(() => {})
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

test(
  'integration: fleet assignment and status update persist admin audit logs',
  { skip: !shouldRunIntegration },
  async (t) => {
    if (!(await hasAdminAuditLogTable())) {
      t.skip('AdminAuditLog table is not migrated in this database')
      return
    }

    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`
    const driverPhone = `+63917${Math.floor(1000000 + Math.random() * 8999999)}`
    const plate = `IT-${Math.random().toString(36).slice(2, 7).toUpperCase()}`

    const admin = await prisma.user.create({
      data: {
        name: `Fleet Ops Admin ${unique}`,
        phone: adminPhone,
        email: `fleet-ops-admin-${unique}@example.com`,
        role: 'ADMIN'
      }
    })
    const driver = await prisma.user.create({
      data: {
        name: `Fleet Driver ${unique}`,
        phone: driverPhone,
        email: `fleet-driver-${unique}@example.com`,
        role: 'DRIVER'
      }
    })
    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: plate,
        model: 'BYD e6',
        capacity: 4,
        batteryCapacityKwh: 71,
        batteryLevel: 65,
        status: 'AVAILABLE'
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    try {
      const assignRes = await request(app)
        .post(`/admin/vehicles/${vehicle.id}/assign-driver`)
        .set('Authorization', `Bearer ${token}`)
        .send({ driverId: driver.id })
      assert.equal(assignRes.status, 200)
      assert.equal(assignRes.body.vehicle.driverId, driver.id)

      const statusRes = await request(app)
        .post(`/admin/vehicles/${vehicle.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'IN_USE', batteryLevel: 65 })
      assert.equal(statusRes.status, 200)
      assert.equal(statusRes.body.vehicle.status, 'IN_USE')

      const logs = await (prisma as any).adminAuditLog.findMany({
        where: {
          adminId: admin.id,
          targetType: 'VEHICLE',
          targetId: vehicle.id,
          action: { in: ['FLEET_ASSIGN_DRIVER', 'FLEET_UPDATE_STATUS'] }
        },
        orderBy: { createdAt: 'asc' },
        select: { action: true, after: true, metadata: true }
      })
      assert.equal(logs.length >= 2, true)

      const actions = new Set(logs.map((row: { action: string }) => row.action))
      assert.equal(actions.has('FLEET_ASSIGN_DRIVER'), true)
      assert.equal(actions.has('FLEET_UPDATE_STATUS'), true)

      const statusLog = logs.find((row: { action: string }) => row.action === 'FLEET_UPDATE_STATUS') as { metadata: { transition?: string } } | undefined
      assert.equal(statusLog?.metadata?.transition, 'AVAILABLE->IN_USE')
    } finally {
      await (prisma as any).adminAuditLog.deleteMany({
        where: {
          OR: [
            { adminId: admin.id },
            { targetId: vehicle.id }
          ]
        }
      }).catch(() => {})
      await prisma.vehicle.deleteMany({ where: { id: vehicle.id } })
      await prisma.user.deleteMany({ where: { id: { in: [admin.id, driver.id] } } })
    }
  }
)

test(
  'integration: pricing update persists admin audit log',
  { skip: !shouldRunIntegration },
  async (t) => {
    if (!(await hasAdminAuditLogTable())) {
      t.skip('AdminAuditLog table is not migrated in this database')
      return
    }

    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`

    const admin = await prisma.user.create({
      data: {
        name: `Pricing Admin ${unique}`,
        phone: adminPhone,
        email: `pricing-admin-${unique}@example.com`,
        role: 'ADMIN'
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    try {
      const res = await request(app)
        .put('/admin/pricing')
        .set('Authorization', `Bearer ${token}`)
        .send({
          baseFare: 60,
          perKmRate: 16,
          perMinuteRate: 3,
          minimumFare: 65,
          currency: 'php'
        })

      assert.equal(res.status, 200)
      assert.equal(res.body.config.baseFare, 60)
      assert.equal(res.body.config.currency, 'PHP')

      const log = await (prisma as any).adminAuditLog.findFirst({
        where: {
          adminId: admin.id,
          action: 'PRICING_UPDATE',
          targetType: 'FARE_CONFIG',
          targetId: 'default'
        },
        orderBy: { createdAt: 'desc' },
        select: { action: true, after: true }
      })

      assert.equal(Boolean(log), true)
      assert.equal(log.action, 'PRICING_UPDATE')
      assert.equal((log.after as { baseFare?: number }).baseFare, 60)
    } finally {
      await (prisma as any).adminAuditLog.deleteMany({
        where: {
          adminId: admin.id,
          action: 'PRICING_UPDATE'
        }
      }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: admin.id } })
    }
  }
)

test(
  'integration: payment verify updates payment state and writes admin audit log',
  { skip: !shouldRunIntegration },
  async (t) => {
    if (!(await hasAdminAuditLogTable())) {
      t.skip('AdminAuditLog table is not migrated in this database')
      return
    }

    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`
    const riderPhone = `+63915${Math.floor(1000000 + Math.random() * 8999999)}`

    const admin = await prisma.user.create({
      data: {
        name: `Payments Admin ${unique}`,
        phone: adminPhone,
        email: `payments-admin-${unique}@example.com`,
        role: 'ADMIN'
      }
    })
    const rider = await prisma.user.create({
      data: {
        name: `Payments Rider ${unique}`,
        phone: riderPhone,
        email: `payments-rider-${unique}@example.com`,
        role: 'PASSENGER'
      }
    })
    const ride = await prisma.ride.create({
      data: {
        riderId: rider.id,
        status: 'COMPLETED',
        pickupAddress: 'SM City Cebu',
        pickupLat: 10.3157,
        pickupLng: 123.8854,
        dropoffAddress: 'Ayala Center Cebu',
        dropoffLat: 10.3176,
        dropoffLng: 123.9053,
        fareAmount: 210,
        currency: 'PHP',
        paymentMethod: 'EWALLET'
      }
    })
    const payment = await prisma.payment.create({
      data: {
        rideId: ride.id,
        method: 'EWALLET',
        amount: 210,
        status: 'PAID',
        reference: `ref-${unique}`
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    try {
      const res = await request(app)
        .post(`/admin/payments/${payment.id}/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 'verified in integration test' })

      assert.equal(res.status, 200)
      assert.equal(res.body.payment.status, 'VERIFIED')

      const updated = await prisma.payment.findUnique({
        where: { id: payment.id },
        select: { status: true }
      })
      assert.equal(updated?.status, 'VERIFIED')

      const audit = await (prisma as any).adminAuditLog.findFirst({
        where: {
          adminId: admin.id,
          action: 'PAYMENT_VERIFY',
          targetType: 'PAYMENT',
          targetId: payment.id
        },
        orderBy: { createdAt: 'desc' },
        select: { before: true, after: true, metadata: true }
      })
      assert.equal(Boolean(audit), true)
      assert.equal((audit.before as { status?: string }).status, 'PAID')
      assert.equal((audit.after as { status?: string }).status, 'VERIFIED')
      assert.equal((audit.metadata as { note?: string }).note, 'verified in integration test')
    } finally {
      await (prisma as any).adminAuditLog.deleteMany({
        where: {
          OR: [
            { adminId: admin.id },
            { targetId: payment.id }
          ]
        }
      }).catch(() => {})
      await prisma.rideEvent.deleteMany({
        where: { rideId: ride.id }
      }).catch(() => {})
      await prisma.payment.deleteMany({
        where: { id: payment.id }
      }).catch(() => {})
      await prisma.ride.deleteMany({
        where: { id: ride.id }
      }).catch(() => {})
      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, rider.id] } }
      }).catch(() => {})
    }
  }
)

test(
  'integration: payment fail updates payment state and writes admin audit log',
  { skip: !shouldRunIntegration },
  async (t) => {
    if (!(await hasAdminAuditLogTable())) {
      t.skip('AdminAuditLog table is not migrated in this database')
      return
    }

    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`
    const riderPhone = `+63915${Math.floor(1000000 + Math.random() * 8999999)}`

    const admin = await prisma.user.create({
      data: {
        name: `Payments Admin ${unique}`,
        phone: adminPhone,
        email: `payments-admin-fail-${unique}@example.com`,
        role: 'ADMIN'
      }
    })
    const rider = await prisma.user.create({
      data: {
        name: `Payments Rider ${unique}`,
        phone: riderPhone,
        email: `payments-rider-fail-${unique}@example.com`,
        role: 'PASSENGER'
      }
    })
    const ride = await prisma.ride.create({
      data: {
        riderId: rider.id,
        status: 'COMPLETED',
        pickupAddress: 'SM Seaside',
        pickupLat: 10.2819,
        pickupLng: 123.8807,
        dropoffAddress: 'IT Park',
        dropoffLat: 10.3306,
        dropoffLng: 123.9067,
        fareAmount: 195,
        currency: 'PHP',
        paymentMethod: 'EWALLET'
      }
    })
    const payment = await prisma.payment.create({
      data: {
        rideId: ride.id,
        method: 'EWALLET',
        amount: 195,
        status: 'PAID',
        reference: `fail-ref-${unique}`
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    try {
      const res = await request(app)
        .post(`/admin/payments/${payment.id}/fail`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'gateway capture failed' })

      assert.equal(res.status, 200)
      assert.equal(res.body.payment.status, 'FAILED')

      const updated = await prisma.payment.findUnique({
        where: { id: payment.id },
        select: { status: true }
      })
      assert.equal(updated?.status, 'FAILED')

      const audit = await (prisma as any).adminAuditLog.findFirst({
        where: {
          adminId: admin.id,
          action: 'PAYMENT_FAIL',
          targetType: 'PAYMENT',
          targetId: payment.id
        },
        orderBy: { createdAt: 'desc' },
        select: { before: true, after: true, metadata: true }
      })
      assert.equal(Boolean(audit), true)
      assert.equal((audit.before as { status?: string }).status, 'PAID')
      assert.equal((audit.after as { status?: string }).status, 'FAILED')
      assert.equal((audit.metadata as { reason?: string }).reason, 'gateway capture failed')
    } finally {
      await (prisma as any).adminAuditLog.deleteMany({
        where: { OR: [{ adminId: admin.id }, { targetId: payment.id }] }
      }).catch(() => {})
      await prisma.rideEvent.deleteMany({ where: { rideId: ride.id } }).catch(() => {})
      await prisma.payment.deleteMany({ where: { id: payment.id } }).catch(() => {})
      await prisma.ride.deleteMany({ where: { id: ride.id } }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: { in: [admin.id, rider.id] } } }).catch(() => {})
    }
  }
)

test(
  'integration: payment refund request updates payment state and writes admin audit log',
  { skip: !shouldRunIntegration },
  async (t) => {
    if (!(await hasAdminAuditLogTable())) {
      t.skip('AdminAuditLog table is not migrated in this database')
      return
    }

    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`
    const riderPhone = `+63915${Math.floor(1000000 + Math.random() * 8999999)}`

    const admin = await prisma.user.create({
      data: {
        name: `Payments Admin ${unique}`,
        phone: adminPhone,
        email: `payments-admin-refund-${unique}@example.com`,
        role: 'ADMIN'
      }
    })
    const rider = await prisma.user.create({
      data: {
        name: `Payments Rider ${unique}`,
        phone: riderPhone,
        email: `payments-rider-refund-${unique}@example.com`,
        role: 'PASSENGER'
      }
    })
    const ride = await prisma.ride.create({
      data: {
        riderId: rider.id,
        status: 'COMPLETED',
        pickupAddress: 'JY Square',
        pickupLat: 10.3342,
        pickupLng: 123.9012,
        dropoffAddress: 'Cebu Business Park',
        dropoffLat: 10.3181,
        dropoffLng: 123.9057,
        fareAmount: 260,
        currency: 'PHP',
        paymentMethod: 'EWALLET'
      }
    })
    const payment = await prisma.payment.create({
      data: {
        rideId: ride.id,
        method: 'EWALLET',
        amount: 260,
        status: 'PAID',
        reference: `refund-ref-${unique}`
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    try {
      const res = await request(app)
        .post(`/admin/payments/${payment.id}/refund`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'partial compensation', amount: 120 })

      assert.equal(res.status, 200)
      assert.equal(res.body.payment.status, 'REFUND_PENDING')

      const updated = await prisma.payment.findUnique({
        where: { id: payment.id },
        select: { status: true }
      })
      assert.equal(updated?.status, 'REFUND_PENDING')

      const audit = await (prisma as any).adminAuditLog.findFirst({
        where: {
          adminId: admin.id,
          action: 'PAYMENT_REFUND_REQUEST',
          targetType: 'PAYMENT',
          targetId: payment.id
        },
        orderBy: { createdAt: 'desc' },
        select: { before: true, after: true, metadata: true }
      })
      assert.equal(Boolean(audit), true)
      assert.equal((audit.before as { status?: string }).status, 'PAID')
      assert.equal((audit.after as { status?: string }).status, 'REFUND_PENDING')
      assert.equal((audit.metadata as { reason?: string }).reason, 'partial compensation')
      assert.equal((audit.metadata as { amount?: number }).amount, 120)
    } finally {
      await (prisma as any).adminAuditLog.deleteMany({
        where: { OR: [{ adminId: admin.id }, { targetId: payment.id }] }
      }).catch(() => {})
      await prisma.rideEvent.deleteMany({ where: { rideId: ride.id } }).catch(() => {})
      await prisma.payment.deleteMany({ where: { id: payment.id } }).catch(() => {})
      await prisma.ride.deleteMany({ where: { id: ride.id } }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: { in: [admin.id, rider.id] } } }).catch(() => {})
    }
  }
)

test(
  'integration: verify on refunded payment is blocked and no PAYMENT_VERIFY audit is written',
  { skip: !shouldRunIntegration },
  async (t) => {
    if (!(await hasAdminAuditLogTable())) {
      t.skip('AdminAuditLog table is not migrated in this database')
      return
    }

    const app = createTestApp()
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const adminPhone = `+63916${Math.floor(1000000 + Math.random() * 8999999)}`
    const riderPhone = `+63915${Math.floor(1000000 + Math.random() * 8999999)}`

    const admin = await prisma.user.create({
      data: {
        name: `Payments Admin ${unique}`,
        phone: adminPhone,
        email: `payments-admin-block-${unique}@example.com`,
        role: 'ADMIN'
      }
    })
    const rider = await prisma.user.create({
      data: {
        name: `Payments Rider ${unique}`,
        phone: riderPhone,
        email: `payments-rider-block-${unique}@example.com`,
        role: 'PASSENGER'
      }
    })
    const ride = await prisma.ride.create({
      data: {
        riderId: rider.id,
        status: 'COMPLETED',
        pickupAddress: 'Fuente',
        pickupLat: 10.3071,
        pickupLng: 123.8915,
        dropoffAddress: 'Capitol',
        dropoffLat: 10.3115,
        dropoffLng: 123.894,
        fareAmount: 150,
        currency: 'PHP',
        paymentMethod: 'EWALLET'
      }
    })
    const payment = await prisma.payment.create({
      data: {
        rideId: ride.id,
        method: 'EWALLET',
        amount: 150,
        status: 'REFUNDED',
        reference: `blocked-verify-ref-${unique}`
      }
    })

    const token = signAuthToken({
      userId: admin.id,
      phone: admin.phone,
      role: 'ADMIN'
    })

    try {
      const res = await request(app)
        .post(`/admin/payments/${payment.id}/verify`)
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 'should not verify' })

      assert.equal(res.status, 409)
      assert.match(res.body.error, /Cannot verify payment/i)

      const auditCount = await (prisma as any).adminAuditLog.count({
        where: {
          adminId: admin.id,
          action: 'PAYMENT_VERIFY',
          targetType: 'PAYMENT',
          targetId: payment.id
        }
      })
      assert.equal(auditCount, 0)
    } finally {
      await (prisma as any).adminAuditLog.deleteMany({
        where: { OR: [{ adminId: admin.id }, { targetId: payment.id }] }
      }).catch(() => {})
      await prisma.rideEvent.deleteMany({ where: { rideId: ride.id } }).catch(() => {})
      await prisma.payment.deleteMany({ where: { id: payment.id } }).catch(() => {})
      await prisma.ride.deleteMany({ where: { id: ride.id } }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: { in: [admin.id, rider.id] } } }).catch(() => {})
    }
  }
)
