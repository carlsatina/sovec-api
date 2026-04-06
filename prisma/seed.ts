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

  await prisma.vehicle.upsert({
    where: { driverId: driver.id },
    update: {},
    create: {
      driverId: driver.id,
      plateNumber: 'ABC-1234',
      model: 'Toyota bZ4X',
      capacity: 4,
      color: 'Pearl White'
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
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
