#!/usr/bin/env node

const API_URL = process.env.API_URL ?? 'http://localhost:4000'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN
const SMOKE_DRIVER_ID = process.env.SMOKE_DRIVER_ID

if (!ADMIN_TOKEN) {
  console.error('Missing ADMIN_TOKEN. Example: ADMIN_TOKEN=<jwt> npm run smoke:admin:fleet')
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
  console.log(`Running admin fleet smoke test against ${API_URL}`)

  const listBefore = await requestJson('/admin/vehicles?page=1&limit=5')
  assertOk('GET /admin/vehicles', listBefore)
  const beforeCount = Array.isArray(listBefore.json?.items) ? listBefore.json.items.length : 0
  console.log(`[PASS] GET /admin/vehicles (items=${beforeCount})`)

  const plateNumber = `SMK-${Date.now().toString().slice(-6)}`
  const createVehicle = await requestJson('/admin/vehicles', {
    method: 'POST',
    body: {
      plateNumber,
      model: 'Smoke EV Unit',
      capacity: 4,
      color: 'Gray',
      status: 'AVAILABLE',
      batteryCapacityKwh: 50,
      batteryLevel: 90
    }
  })
  assertOk('POST /admin/vehicles', createVehicle)
  const vehicleId = createVehicle.json?.vehicle?.id
  if (!vehicleId || typeof vehicleId !== 'string') {
    console.error('[FAIL] POST /admin/vehicles response missing vehicle.id')
    process.exit(1)
  }
  console.log(`[PASS] POST /admin/vehicles (id=${vehicleId}, plate=${plateNumber})`)

  const updateStatus = await requestJson(`/admin/vehicles/${vehicleId}/status`, {
    method: 'POST',
    body: { status: 'CHARGING', batteryLevel: 61 }
  })
  assertOk('POST /admin/vehicles/:id/status', updateStatus)
  console.log('[PASS] POST /admin/vehicles/:id/status')

  if (SMOKE_DRIVER_ID) {
    const assign = await requestJson(`/admin/vehicles/${vehicleId}/assign-driver`, {
      method: 'POST',
      body: { driverId: SMOKE_DRIVER_ID }
    })
    assertOk('POST /admin/vehicles/:id/assign-driver', assign)
    console.log(`[PASS] POST /admin/vehicles/:id/assign-driver (driverId=${SMOKE_DRIVER_ID})`)
  } else {
    console.log('[SKIP] POST /admin/vehicles/:id/assign-driver (set SMOKE_DRIVER_ID to enable)')
  }

  const listAfter = await requestJson('/admin/vehicles?page=1&limit=5')
  assertOk('GET /admin/vehicles after write', listAfter)
  const afterCount = Array.isArray(listAfter.json?.items) ? listAfter.json.items.length : 0
  console.log(`[PASS] GET /admin/vehicles after write (items=${afterCount})`)

  console.log('Admin fleet smoke test completed successfully.')
}

run().catch((err) => {
  console.error('[FAIL] Unexpected error')
  console.error(err)
  process.exit(1)
})
