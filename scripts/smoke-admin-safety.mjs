#!/usr/bin/env node

const API_URL = process.env.API_URL ?? 'http://localhost:4000'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN
const SMOKE_SAFETY_INCIDENT_ID = process.env.SMOKE_SAFETY_INCIDENT_ID
const SMOKE_RETRY_DEAD_LETTER = (process.env.SMOKE_RETRY_DEAD_LETTER ?? '').trim().toLowerCase() === 'true'

if (!ADMIN_TOKEN) {
  console.error('Missing ADMIN_TOKEN. Example: ADMIN_TOKEN=<jwt> SMOKE_SUITES=admin-safety npm run smoke')
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

function assertMetricsShape(metrics, label) {
  const requiredNumberFields = [
    'days',
    'totalIncidents',
    'openIncidents',
    'criticalOpenIncidents',
    'overdueOpenIncidents'
  ]

  for (const field of requiredNumberFields) {
    if (typeof metrics?.[field] !== 'number') {
      console.error(`[FAIL] ${label} invalid field "${field}"`)
      console.error(metrics)
      process.exit(1)
    }
  }

  const isNullableNumber = (value) => value === null || typeof value === 'number'
  if (!isNullableNumber(metrics?.avgAckSeconds) || !isNullableNumber(metrics?.avgResolveSeconds)) {
    console.error(`[FAIL] ${label} invalid SLA averages`)
    console.error(metrics)
    process.exit(1)
  }

  const byPriority = Array.isArray(metrics?.byPriority) ? metrics.byPriority : null
  if (!byPriority || byPriority.length !== 4) {
    console.error(`[FAIL] ${label} invalid byPriority breakdown`)
    console.error(metrics)
    process.exit(1)
  }
}

async function resolveIncidentId() {
  if (SMOKE_SAFETY_INCIDENT_ID) return SMOKE_SAFETY_INCIDENT_ID

  const list = await requestJson('/admin/safety/incidents?activeOnly=true&page=1&limit=20')
  assertOk('GET /admin/safety/incidents', list)

  const items = Array.isArray(list.json?.items) ? list.json.items : []
  if (items.length === 0) {
    console.error('[FAIL] No active safety incidents found. Seed one or set SMOKE_SAFETY_INCIDENT_ID.')
    process.exit(1)
  }

  return items[0]?.id
}

async function run() {
  console.log(`Running admin safety smoke test against ${API_URL}`)

  const templates = await requestJson('/admin/safety/templates')
  assertOk('GET /admin/safety/templates', templates)
  console.log('[PASS] GET /admin/safety/templates')

  const logs = await requestJson('/admin/safety/delivery-logs?page=1&limit=5')
  assertOk('GET /admin/safety/delivery-logs', logs)
  console.log('[PASS] GET /admin/safety/delivery-logs')

  const metricsBefore = await requestJson('/admin/safety/metrics?days=7')
  assertOk('GET /admin/safety/metrics', metricsBefore)
  assertMetricsShape(metricsBefore.json, 'GET /admin/safety/metrics')
  console.log('[PASS] GET /admin/safety/metrics (shape validated)')

  const updateTemplate = await requestJson('/admin/safety/templates/ESCALATION_ADMIN', {
    method: 'PUT',
    body: { subject: 'Safety Escalation {{incidentId}} [{{priority}}]' }
  })
  assertOk('PUT /admin/safety/templates/:key', updateTemplate)
  console.log('[PASS] PUT /admin/safety/templates/:key')

  const before = await requestJson('/admin/safety/incidents?activeOnly=true&page=1&limit=5')
  assertOk('GET /admin/safety/incidents active', before)
  const activeCount = Array.isArray(before.json?.items) ? before.json.items.length : 0
  console.log(`[PASS] GET /admin/safety/incidents active (items=${activeCount})`)

  const incidentId = await resolveIncidentId()
  if (!incidentId || typeof incidentId !== 'string') {
    console.error('[FAIL] Could not resolve safety incident id')
    process.exit(1)
  }
  console.log(`[INFO] Using incident id=${incidentId}`)

  const acknowledge = await requestJson(`/admin/safety/incidents/${incidentId}/acknowledge`, {
    method: 'POST',
    body: {
      note: 'Smoke acknowledge'
    }
  })
  assertOk('POST /admin/safety/incidents/:id/acknowledge', acknowledge)
  console.log('[PASS] POST /admin/safety/incidents/:id/acknowledge')

  const assign = await requestJson(`/admin/safety/incidents/${incidentId}/assign`, {
    method: 'POST',
    body: {
      note: 'Smoke assign'
    }
  })
  assertOk('POST /admin/safety/incidents/:id/assign', assign)
  console.log('[PASS] POST /admin/safety/incidents/:id/assign')

  const escalate = await requestJson(`/admin/safety/incidents/${incidentId}/escalate`, {
    method: 'POST',
    body: {
      priority: 'CRITICAL',
      reason: 'Smoke escalation path test'
    }
  })
  assertOk('POST /admin/safety/incidents/:id/escalate', escalate)
  console.log('[PASS] POST /admin/safety/incidents/:id/escalate')

  const resolve = await requestJson(`/admin/safety/incidents/${incidentId}/resolve`, {
    method: 'POST',
    body: {
      status: 'RESOLVED',
      action: 'Smoke test resolution',
      note: 'Resolved by automated safety smoke test'
    }
  })
  assertOk('POST /admin/safety/incidents/:id/resolve', resolve)
  console.log('[PASS] POST /admin/safety/incidents/:id/resolve')

  const resolvedList = await requestJson('/admin/safety/incidents?status=RESOLVED&activeOnly=false&page=1&limit=10')
  assertOk('GET /admin/safety/incidents resolved', resolvedList)
  const resolvedItems = Array.isArray(resolvedList.json?.items) ? resolvedList.json.items : []
  const found = resolvedItems.some((item) => item?.id === incidentId)
  if (!found) {
    console.error('[FAIL] Resolved incident not found in resolved list')
    process.exit(1)
  }
  console.log('[PASS] GET /admin/safety/incidents resolved (updated incident found)')

  const metricsAfter = await requestJson('/admin/safety/metrics?days=7')
  assertOk('GET /admin/safety/metrics after lifecycle', metricsAfter)
  assertMetricsShape(metricsAfter.json, 'GET /admin/safety/metrics after lifecycle')
  console.log('[PASS] GET /admin/safety/metrics after lifecycle (shape validated)')

  const deadLetters = await requestJson(`/admin/safety/delivery-logs?incidentId=${encodeURIComponent(incidentId)}&status=DEAD_LETTER&page=1&limit=5`)
  assertOk('GET /admin/safety/delivery-logs dead letters', deadLetters)
  const deadLetterItems = Array.isArray(deadLetters.json?.items) ? deadLetters.json.items : []
  if (!SMOKE_RETRY_DEAD_LETTER) {
    console.log('[INFO] Skipping dead-letter retry. Set SMOKE_RETRY_DEAD_LETTER=true to enable.')
  } else if (deadLetterItems.length > 0 && deadLetterItems[0]?.id) {
    const retry = await requestJson(`/admin/safety/delivery-logs/${deadLetterItems[0].id}/retry`, { method: 'POST' })
    assertOk('POST /admin/safety/delivery-logs/:id/retry', retry)
    console.log('[PASS] POST /admin/safety/delivery-logs/:id/retry')
  } else {
    console.log('[INFO] No dead-letter log available for retry in this environment')
  }

  console.log('Admin safety smoke test completed successfully.')
}

run().catch((err) => {
  console.error('[FAIL] Unexpected error')
  console.error(err)
  process.exit(1)
})
