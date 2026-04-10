#!/usr/bin/env node

const API_URL = process.env.API_URL ?? 'http://localhost:4000'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN
const SMOKE_ANALYTICS_DAYS = Number(process.env.SMOKE_ANALYTICS_DAYS ?? 7)

if (!ADMIN_TOKEN) {
  console.error('Missing ADMIN_TOKEN. Example: ADMIN_TOKEN=<jwt> npm run smoke:admin:analytics')
  process.exit(1)
}

if (!Number.isInteger(SMOKE_ANALYTICS_DAYS) || SMOKE_ANALYTICS_DAYS < 1 || SMOKE_ANALYTICS_DAYS > 90) {
  console.error('Invalid SMOKE_ANALYTICS_DAYS. Use an integer between 1 and 90.')
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

async function run() {
  console.log(`Running admin analytics smoke test against ${API_URL}`)

  const overview = await requestJson('/admin/analytics/overview')
  assertOk('GET /admin/analytics/overview', overview)

  const today = overview.json?.today
  const rolling30d = overview.json?.rolling30d
  if (!today || typeof today.rides !== 'number' || typeof today.revenue !== 'number') {
    console.error('[FAIL] Invalid overview.today payload')
    console.error(overview.json)
    process.exit(1)
  }
  if (!rolling30d || typeof rolling30d.completionRate !== 'number' || typeof rolling30d.cancellationRate !== 'number') {
    console.error('[FAIL] Invalid overview.rolling30d payload')
    console.error(overview.json)
    process.exit(1)
  }
  console.log('[PASS] GET /admin/analytics/overview')

  const trends = await requestJson(`/admin/analytics/trends?days=${encodeURIComponent(String(SMOKE_ANALYTICS_DAYS))}`)
  assertOk('GET /admin/analytics/trends', trends)

  const items = Array.isArray(trends.json?.items) ? trends.json.items : null
  if (!items) {
    console.error('[FAIL] trends.items is not an array')
    console.error(trends.json)
    process.exit(1)
  }
  if (Number(trends.json?.days) !== SMOKE_ANALYTICS_DAYS) {
    console.error('[FAIL] trends.days did not match requested days')
    console.error(trends.json)
    process.exit(1)
  }

  const invalid = items.find((item) =>
    typeof item?.day !== 'string'
    || typeof item?.rides !== 'number'
    || typeof item?.completedRides !== 'number'
    || typeof item?.cancelledRides !== 'number'
    || typeof item?.revenue !== 'number'
  )

  if (invalid) {
    console.error('[FAIL] trends.items contains invalid row')
    console.error(invalid)
    process.exit(1)
  }

  console.log(`[PASS] GET /admin/analytics/trends (days=${SMOKE_ANALYTICS_DAYS}, items=${items.length})`)
  console.log('Admin analytics smoke test completed successfully.')
}

run().catch((err) => {
  console.error('[FAIL] Unexpected error')
  console.error(err)
  process.exit(1)
})
