import prisma from '../db.js'
import { normalizePhoneForIdentity } from './phone.js'

type UserRole = 'PASSENGER' | 'DRIVER' | 'ADMIN'

export type AdminBootstrapResult = {
  userId: string
  phone: string
  previousRole: UserRole
  nextRole: UserRole
  changed: boolean
}

export function parseBooleanEnv(value: string | undefined) {
  return (value ?? '').trim().toLowerCase() === 'true'
}

export function verifyBootstrapSecret(configuredSecret: string | undefined, providedSecret: string | undefined) {
  const configured = configuredSecret?.trim() ?? ''
  const provided = providedSecret?.trim() ?? ''
  if (!configured) return
  if (!provided || provided !== configured) {
    throw new Error('Invalid bootstrap secret')
  }
}

export async function promoteUserToAdminByPhone(rawPhone: string, options?: {
  allowWhenAdminExists?: boolean
}): Promise<AdminBootstrapResult> {
  const phone = normalizePhoneForIdentity(rawPhone)
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(918273645)`

    const user = await tx.user.findUnique({
      where: { phone },
      select: { id: true, phone: true, role: true }
    })

    if (!user) {
      throw new Error(`User not found for ${phone}. Register/login this phone first.`)
    }

    if (user.role === 'ADMIN') {
      return {
        userId: user.id,
        phone: user.phone,
        previousRole: 'ADMIN',
        nextRole: 'ADMIN',
        changed: false
      }
    }

    const allowWhenAdminExists = Boolean(options?.allowWhenAdminExists)
    const existingAdminCount = await tx.user.count({
      where: { role: 'ADMIN' }
    })
    if (existingAdminCount > 0 && !allowWhenAdminExists) {
      throw new Error('Admin bootstrap is disabled because an ADMIN user already exists. Set ALLOW_ADMIN_BOOTSTRAP_WHEN_ADMIN_EXISTS=true to override.')
    }

    const updated = await tx.user.update({
      where: { id: user.id },
      data: { role: 'ADMIN' },
      select: { id: true, phone: true, role: true }
    })

    return {
      userId: updated.id,
      phone: updated.phone,
      previousRole: user.role as UserRole,
      nextRole: updated.role as UserRole,
      changed: true
    }
  })
}
