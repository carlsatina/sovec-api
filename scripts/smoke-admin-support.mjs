#!/usr/bin/env node

const API_URL = process.env.API_URL ?? 'http://localhost:4000'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN
const SMOKE_SUPPORT_TICKET_ID = process.env.SMOKE_SUPPORT_TICKET_ID
const SMOKE_SUPPORT_CATEGORY = process.env.SMOKE_SUPPORT_CATEGORY ?? 'SAFETY'

if (!ADMIN_TOKEN) {
  console.error('Missing ADMIN_TOKEN. Example: ADMIN_TOKEN=<jwt> npm run smoke:admin:support')
  process.exit(1)
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(options.headers ?? {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  })

  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }

  return { ok: res.ok, status: res.status, json }
}

function assertOk(label, response) {
  if (!response.ok) {
    console.error(`[FAIL] ${label} (${response.status})`)
    console.error(response.json)
    process.exit(1)
  }
}

async function resolveTicketId() {
  if (SMOKE_SUPPORT_TICKET_ID) return SMOKE_SUPPORT_TICKET_ID

  const list = await requestJson('/admin/support/tickets?page=1&limit=20')
  assertOk('GET /admin/support/tickets', list)

  const items = Array.isArray(list.json?.items) ? list.json.items : []
  if (items.length === 0) {
    console.error('[FAIL] No support tickets found. Seed or create at least one support ticket, or set SMOKE_SUPPORT_TICKET_ID.')
    process.exit(1)
  }

  const preferred = items.find((item) => item?.status === 'OPEN')
  return preferred?.id ?? items[0]?.id
}

async function run() {
  console.log(`Running admin support smoke test against ${API_URL}`)

  const listBefore = await requestJson(`/admin/support/tickets?category=${encodeURIComponent(SMOKE_SUPPORT_CATEGORY)}&page=1&limit=5`)
  assertOk('GET /admin/support/tickets (filtered)', listBefore)
  const beforeCount = Array.isArray(listBefore.json?.items) ? listBefore.json.items.length : 0
  console.log(`[PASS] GET /admin/support/tickets (filtered items=${beforeCount})`)

  const ticketId = await resolveTicketId()
  if (!ticketId || typeof ticketId !== 'string') {
    console.error('[FAIL] Could not resolve a support ticket id')
    process.exit(1)
  }
  console.log(`[INFO] Using ticket id=${ticketId}`)

  const setInReview = await requestJson(`/admin/support/tickets/${ticketId}/status`, {
    method: 'POST',
    body: { status: 'IN_REVIEW', note: 'Smoke: assigned to support ops' }
  })
  assertOk('POST /admin/support/tickets/:id/status -> IN_REVIEW', setInReview)
  console.log('[PASS] POST /admin/support/tickets/:id/status -> IN_REVIEW')

  const setResolved = await requestJson(`/admin/support/tickets/${ticketId}/status`, {
    method: 'POST',
    body: { status: 'RESOLVED', note: 'Smoke: marked resolved' }
  })
  assertOk('POST /admin/support/tickets/:id/status -> RESOLVED', setResolved)
  console.log('[PASS] POST /admin/support/tickets/:id/status -> RESOLVED')

  const listAfter = await requestJson('/admin/support/tickets?status=RESOLVED&page=1&limit=10')
  assertOk('GET /admin/support/tickets?status=RESOLVED', listAfter)
  const resolvedItems = Array.isArray(listAfter.json?.items) ? listAfter.json.items : []
  const found = resolvedItems.some((item) => item?.id === ticketId)
  if (!found) {
    console.error('[FAIL] Updated ticket not found in resolved list')
    process.exit(1)
  }
  console.log('[PASS] GET /admin/support/tickets?status=RESOLVED (updated ticket found)')

  console.log('Admin support smoke test completed successfully.')
}

run().catch((err) => {
  console.error('[FAIL] Unexpected error')
  console.error(err)
  process.exit(1)
})
