#!/usr/bin/env tsx

import prisma from '../src/db.js'
import { parseBooleanEnv, promoteUserToAdminByPhone, verifyBootstrapSecret } from '../src/lib/admin-bootstrap.js'

async function main() {
  const phone = process.env.BOOTSTRAP_PHONE?.trim()
  if (!phone) {
    console.error('Missing BOOTSTRAP_PHONE. Example:')
    console.error('BOOTSTRAP_PHONE=+639171111111 ADMIN_BOOTSTRAP_SECRET=<secret> BOOTSTRAP_SECRET=<secret> npm run admin:bootstrap')
    process.exit(1)
  }

  const configuredSecret = process.env.ADMIN_BOOTSTRAP_SECRET
  const providedSecret = process.env.BOOTSTRAP_SECRET
  const allowInsecure = parseBooleanEnv(process.env.ALLOW_INSECURE_ADMIN_BOOTSTRAP)
  if (!configuredSecret && !allowInsecure) {
    console.error('Missing ADMIN_BOOTSTRAP_SECRET. Refusing insecure bootstrap.')
    console.error('Set ADMIN_BOOTSTRAP_SECRET and BOOTSTRAP_SECRET, or explicitly set ALLOW_INSECURE_ADMIN_BOOTSTRAP=true for local-only setup.')
    process.exit(1)
  }
  verifyBootstrapSecret(configuredSecret, providedSecret)

  const allowWhenAdminExists = parseBooleanEnv(process.env.ALLOW_ADMIN_BOOTSTRAP_WHEN_ADMIN_EXISTS)
  const result = await promoteUserToAdminByPhone(phone, { allowWhenAdminExists })

  const mode = result.changed ? 'promoted' : 'already_admin'
  console.log(JSON.stringify({
    ok: true,
    mode,
    userId: result.userId,
    phone: result.phone,
    previousRole: result.previousRole,
    nextRole: result.nextRole
  }, null, 2))
}

main()
  .catch((err) => {
    console.error('[FAIL] admin bootstrap failed')
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
