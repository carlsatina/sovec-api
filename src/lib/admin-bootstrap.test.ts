import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import prisma from '../db.js'
import { promoteUserToAdminByPhone, verifyBootstrapSecret } from './admin-bootstrap.js'

const originalUser = (prisma as any).user
const originalTransaction = (prisma as any).$transaction

afterEach(() => {
  ;(prisma as any).user = originalUser
  ;(prisma as any).$transaction = originalTransaction
})

test('promoteUserToAdminByPhone throws when user does not exist', async () => {
  ;(prisma as any).$transaction = async (fn: any) => fn({
    user: (prisma as any).user,
    $queryRaw: async () => []
  })
  ;(prisma as any).user = {
    findUnique: async () => null
  }

  await assert.rejects(
    () => promoteUserToAdminByPhone('+639171111111'),
    /User not found/i
  )
})

test('promoteUserToAdminByPhone promotes PASSENGER to ADMIN', async () => {
  ;(prisma as any).$transaction = async (fn: any) => fn({
    user: (prisma as any).user,
    $queryRaw: async () => []
  })
  let updateCalls = 0
  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'user-1', phone: '+639171111111', role: 'PASSENGER' }),
    count: async () => 0,
    update: async () => {
      updateCalls += 1
      return { id: 'user-1', phone: '+639171111111', role: 'ADMIN' }
    }
  }

  const result = await promoteUserToAdminByPhone('+639171111111')
  assert.equal(updateCalls, 1)
  assert.equal(result.changed, true)
  assert.equal(result.previousRole, 'PASSENGER')
  assert.equal(result.nextRole, 'ADMIN')
})

test('promoteUserToAdminByPhone promotes DRIVER to ADMIN', async () => {
  ;(prisma as any).$transaction = async (fn: any) => fn({
    user: (prisma as any).user,
    $queryRaw: async () => []
  })
  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'user-2', phone: '+639172222222', role: 'DRIVER' }),
    count: async () => 0,
    update: async () => ({ id: 'user-2', phone: '+639172222222', role: 'ADMIN' })
  }

  const result = await promoteUserToAdminByPhone('+639172222222')
  assert.equal(result.changed, true)
  assert.equal(result.previousRole, 'DRIVER')
  assert.equal(result.nextRole, 'ADMIN')
})

test('promoteUserToAdminByPhone is idempotent for existing ADMIN user', async () => {
  ;(prisma as any).$transaction = async (fn: any) => fn({
    user: (prisma as any).user,
    $queryRaw: async () => []
  })
  let countCalls = 0
  let updateCalls = 0
  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'admin-1', phone: '+639179999999', role: 'ADMIN' }),
    count: async () => {
      countCalls += 1
      return 1
    },
    update: async () => {
      updateCalls += 1
      return { id: 'admin-1', phone: '+639179999999', role: 'ADMIN' }
    }
  }

  const result = await promoteUserToAdminByPhone('+639179999999')
  assert.equal(result.changed, false)
  assert.equal(result.previousRole, 'ADMIN')
  assert.equal(result.nextRole, 'ADMIN')
  assert.equal(countCalls, 0)
  assert.equal(updateCalls, 0)
})

test('promoteUserToAdminByPhone blocks when an admin already exists', async () => {
  ;(prisma as any).$transaction = async (fn: any) => fn({
    user: (prisma as any).user,
    $queryRaw: async () => []
  })
  ;(prisma as any).user = {
    findUnique: async () => ({ id: 'user-1', phone: '+639171111111', role: 'PASSENGER' }),
    count: async () => 1
  }

  await assert.rejects(
    () => promoteUserToAdminByPhone('+639171111111'),
    /already exists/i
  )
})

test('verifyBootstrapSecret validates configured secret', () => {
  assert.doesNotThrow(() => verifyBootstrapSecret(undefined, undefined))
  assert.doesNotThrow(() => verifyBootstrapSecret('top-secret', 'top-secret'))
  assert.throws(() => verifyBootstrapSecret('top-secret', 'wrong'), /Invalid bootstrap secret/i)
})
