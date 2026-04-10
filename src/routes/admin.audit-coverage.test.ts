import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const adminRouteSource = readFileSync(path.join(__dirname, 'admin.ts'), 'utf8')

type MutatingRoute = {
  method: 'post' | 'put' | 'patch' | 'delete'
  path: string
  start: number
}

function collectMutatingRoutes(source: string): MutatingRoute[] {
  const regex = /router\.(post|put|patch|delete)\(\s*'([^']+)'/g
  const routes: MutatingRoute[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(source)) !== null) {
    routes.push({
      method: match[1] as MutatingRoute['method'],
      path: match[2],
      start: match.index
    })
  }
  return routes
}

function routeKey(route: { method: string; path: string }) {
  return `${route.method.toUpperCase()} ${route.path}`
}

const routes = collectMutatingRoutes(adminRouteSource)
const mutatingRouteKeys = routes.map(routeKey)

const auditedRouteKeys = new Set<string>([
  'POST /driver-applications/:id/status',
  'POST /driver-applications/:id/interview',
  'POST /rides/:id/force-cancel',
  'POST /rides/:id/reassign',
  'POST /payments/:id/verify',
  'POST /payments/:id/fail',
  'POST /payments/:id/refund',
  'POST /support/tickets/:id/status',
  'PUT /safety/templates/:key',
  'POST /safety/delivery-logs/:id/retry',
  'POST /safety/incidents/:id/resolve',
  'POST /safety/incidents/:id/acknowledge',
  'POST /safety/incidents/:id/assign',
  'POST /safety/incidents/:id/escalate',
  'POST /vehicles',
  'POST /vehicles/:id/assign-driver',
  'POST /vehicles/:id/status',
  'PUT /pricing'
])

const exemptRouteKeys = new Set<string>([])

test('admin mutating routes are explicitly classified as audited or exempt', () => {
  const known = new Set([...auditedRouteKeys, ...exemptRouteKeys])
  const unknownRoutes = mutatingRouteKeys.filter((key) => !known.has(key))
  assert.deepEqual(
    unknownRoutes,
    [],
    `Found unclassified mutating admin routes: ${unknownRoutes.join(', ')}`
  )

  const staleAudited = [...auditedRouteKeys].filter((key) => !mutatingRouteKeys.includes(key))
  const staleExempt = [...exemptRouteKeys].filter((key) => !mutatingRouteKeys.includes(key))
  assert.deepEqual(staleAudited, [], `Audited route list has stale entries: ${staleAudited.join(', ')}`)
  assert.deepEqual(staleExempt, [], `Exempt route list has stale entries: ${staleExempt.join(', ')}`)
})

test('audited mutating routes call recordAdminAudit', () => {
  for (let i = 0; i < routes.length; i += 1) {
    const current = routes[i]
    const key = routeKey(current)
    if (!auditedRouteKeys.has(key)) continue

    const end = i + 1 < routes.length ? routes[i + 1].start : adminRouteSource.length
    const routeBlock = adminRouteSource.slice(current.start, end)
    const hasAuditCall = routeBlock.includes('recordAdminAudit(')
    assert.equal(hasAuditCall, true, `Expected ${key} to call recordAdminAudit(...)`)
  }
})
