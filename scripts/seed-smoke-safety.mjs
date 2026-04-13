#!/usr/bin/env node

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const phone = process.env.SMOKE_SAFETY_PHONE ?? '+639151234999'
const category = process.env.SMOKE_SAFETY_CATEGORY ?? 'SOS'
const description = process.env.SMOKE_SAFETY_DESCRIPTION ?? `Smoke safety incident seed ${new Date().toISOString()}`

async function main() {
  const user = await prisma.user.upsert({
    where: { phone },
    update: { role: 'PASSENGER' },
    create: {
      name: 'Smoke Safety Passenger',
      phone,
      role: 'PASSENGER'
    }
  })

  const incident = await prisma.supportTicket.create({
    data: {
      userId: user.id,
      category,
      description,
      status: 'OPEN'
    }
  })

  console.log(JSON.stringify({
    ok: true,
    incidentId: incident.id,
    userId: user.id,
    phone: user.phone,
    status: incident.status
  }, null, 2))
}

main()
  .catch((err) => {
    console.error('[FAIL] seed-smoke-safety', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

