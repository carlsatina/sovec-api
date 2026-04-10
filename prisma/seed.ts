import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const passenger = await prisma.user.upsert({
    where: { phone: '+639171111111' },
    update: {},
    create: {
      name: 'Maria Santos',
      phone: '+639171111111',
      email: 'maria@example.com',
      role: 'PASSENGER',
      profile: {
        create: {
          homeAddress: 'Makati Avenue, Makati City',
          workAddress: 'BGC, Taguig City'
        }
      },
      rewardWallet: {
        create: { points: 1240, balance: 0 }
      }
    }
  })

  const driver = await prisma.user.upsert({
    where: { phone: '+639172222222' },
    update: {},
    create: {
      name: 'Juan Dela Cruz',
      phone: '+639172222222',
      email: 'juan@example.com',
      role: 'DRIVER'
    }
  })

  const driver2 = await prisma.user.upsert({
    where: { phone: '+639173333333' },
    update: {
      role: 'DRIVER'
    },
    create: {
      name: 'Carlo Reyes',
      phone: '+639173333333',
      email: 'carlo.reyes@example.com',
      role: 'DRIVER'
    }
  })

  const driver3 = await prisma.user.upsert({
    where: { phone: '+639174444444' },
    update: {
      role: 'DRIVER'
    },
    create: {
      name: 'Miguel Santos',
      phone: '+639174444444',
      email: 'miguel.santos@example.com',
      role: 'DRIVER'
    }
  })

  await prisma.user.upsert({
    where: { phone: '+639179999999' },
    update: {
      role: 'ADMIN'
    },
    create: {
      name: 'Admin User',
      phone: '+639179999999',
      email: 'admin@example.com',
      role: 'ADMIN'
    }
  })

  await prisma.vehicle.upsert({
    where: { plateNumber: 'ABC-1234' },
    update: {
      driverId: driver.id,
      model: 'Toyota bZ4X',
      capacity: 4,
      color: 'Pearl White',
      status: 'AVAILABLE',
      batteryCapacityKwh: 71.4,
      batteryLevel: 78
    },
    create: {
      driverId: driver.id,
      plateNumber: 'ABC-1234',
      model: 'Toyota bZ4X',
      capacity: 4,
      color: 'Pearl White',
      status: 'AVAILABLE',
      batteryCapacityKwh: 71.4,
      batteryLevel: 78
    }
  })

  await prisma.vehicle.upsert({
    where: { plateNumber: 'EV-2401' },
    update: {
      model: 'BYD Dolphin',
      capacity: 4,
      color: 'Blue',
      status: 'CHARGING',
      batteryCapacityKwh: 44.9,
      batteryLevel: 32,
      driverId: null
    },
    create: {
      plateNumber: 'EV-2401',
      model: 'BYD Dolphin',
      capacity: 4,
      color: 'Blue',
      status: 'CHARGING',
      batteryCapacityKwh: 44.9,
      batteryLevel: 32
    }
  })

  await prisma.vehicle.upsert({
    where: { plateNumber: 'EV-2402' },
    update: {
      model: 'Nissan Leaf',
      capacity: 4,
      color: 'Silver',
      status: 'MAINTENANCE',
      batteryCapacityKwh: 40,
      batteryLevel: 55,
      driverId: null
    },
    create: {
      plateNumber: 'EV-2402',
      model: 'Nissan Leaf',
      capacity: 4,
      color: 'Silver',
      status: 'MAINTENANCE',
      batteryCapacityKwh: 40,
      batteryLevel: 55
    }
  })

  await prisma.driverLocation.upsert({
    where: { driverId: driver.id },
    update: { lat: 14.5537, lng: 121.0250, isAvailable: true },
    create: {
      driverId: driver.id,
      lat: 14.5537,
      lng: 121.0250,
      isAvailable: true
    }
  })

  await prisma.driverLocation.upsert({
    where: { driverId: driver2.id },
    update: { lat: 14.5608, lng: 121.0179, isAvailable: true },
    create: {
      driverId: driver2.id,
      lat: 14.5608,
      lng: 121.0179,
      isAvailable: true
    }
  })

  await prisma.driverLocation.upsert({
    where: { driverId: driver3.id },
    update: { lat: 14.5451, lng: 121.0395, isAvailable: true },
    create: {
      driverId: driver3.id,
      lat: 14.5451,
      lng: 121.0395,
      isAvailable: true
    }
  })

  await prisma.promo.upsert({
    where: { code: 'GREEN50' },
    update: {},
    create: {
      code: 'GREEN50',
      discountType: 'FLAT',
      value: 50,
      expiresAt: new Date(new Date().setMonth(new Date().getMonth() + 3)),
      isActive: true
    }
  })

  await prisma.ride.create({
    data: {
      riderId: passenger.id,
      driverId: driver.id,
      status: 'COMPLETED',
      pickupAddress: 'Ayala Avenue, Makati City',
      pickupLat: 14.5547,
      pickupLng: 121.0244,
      dropoffAddress: 'BGC High Street, Taguig City',
      dropoffLat: 14.5528,
      dropoffLng: 121.0514,
      fareAmount: 286,
      currency: 'PHP',
      paymentMethod: 'CASH',
      payment: {
        create: {
          method: 'CASH',
          amount: 286,
          status: 'PAID'
        }
      },
      events: {
        create: [
          { type: 'REQUESTED' },
          { type: 'ASSIGNED' },
          { type: 'COMPLETED' }
        ]
      }
    }
  })

  await prisma.driverApplication.upsert({
    where: { userId: driver.id },
    update: {},
    create: {
      userId: driver.id,
      fullName: driver.name,
      phone: driver.phone,
      email: driver.email ?? undefined,
      address: 'Taguig City, Metro Manila',
      experienceYears: 5,
      preferredArea: 'BGC, Makati',
      status: 'UNDER_REVIEW',
      submittedAt: new Date(),
      documents: {
        create: [
          { type: 'LICENSE', fileUrl: 'https://example.com/license.jpg', status: 'APPROVED' },
          { type: 'NBI_CLEARANCE', fileUrl: 'https://example.com/nbi.jpg', status: 'PENDING' }
        ]
      },
      availability: {
        create: {
          days: 'Mon-Fri',
          hours: '07:00-21:00',
          preferredCity: 'Taguig'
        }
      }
    }
  })

  await prisma.fareConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      baseFare: 55,
      perKmRate: 15,
      perMinuteRate: 2.8,
      minimumFare: 55,
      currency: 'PHP'
    }
  })

  await prisma.safetyTemplate.upsert({
    where: { key: 'ESCALATION_ADMIN' },
    update: {},
    create: {
      key: 'ESCALATION_ADMIN',
      subject: 'Safety Escalation {{incidentId}} ({{priority}})',
      body: 'Incident {{incidentId}} has been escalated to {{priority}}. Reason: {{reason}}. Ride: {{rideId}}.'
    }
  })
  await prisma.safetyTemplate.upsert({
    where: { key: 'ESCALATION_REPORTER' },
    update: {},
    create: {
      key: 'ESCALATION_REPORTER',
      subject: 'Your Safety Incident Is Escalated',
      body: 'Your incident {{incidentId}} is now {{priority}} priority. The team is actively handling this case.'
    }
  })
  await prisma.safetyTemplate.upsert({
    where: { key: 'RESOLUTION_REPORTER' },
    update: {},
    create: {
      key: 'RESOLUTION_REPORTER',
      subject: 'Safety Incident {{incidentId}} Update',
      body: 'Your safety incident {{incidentId}} was marked {{status}}. Action: {{action}}. Note: {{note}}.'
    }
  })

  const supportTicketCount = await prisma.supportTicket.count()
  if (supportTicketCount === 0) {
    await prisma.supportTicket.createMany({
      data: [
        {
          userId: passenger.id,
          category: 'SAFETY',
          description: 'Driver took an unexpected route and rider requested a safety check.',
          status: 'OPEN'
        },
        {
          userId: passenger.id,
          category: 'PAYMENT',
          description: 'Cash payment marked as unpaid in app after trip completion.',
          status: 'IN_REVIEW'
        }
      ]
    })
  }
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
