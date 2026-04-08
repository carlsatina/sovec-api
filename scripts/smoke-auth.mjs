#!/usr/bin/env node

const API_URL = process.env.API_URL ?? 'http://localhost:4000'
const SMOKE_PHONE = process.env.SMOKE_PHONE
const SMOKE_OTP_CODE = process.env.SMOKE_OTP_CODE

if (!SMOKE_PHONE) {
  console.error('Missing SMOKE_PHONE. Example: SMOKE_PHONE=+639171111111 npm run smoke:auth')
  process.exit(1)
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
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

  return { ok: res.ok, status: res.status, headers: res.headers, json }
}

function assertOk(label, response) {
  if (!response.ok) {
    console.error(`[FAIL] ${label} (${response.status})`)
    console.error(response.json)
    process.exit(1)
  }
}

async function run() {
  console.log(`Running auth smoke test against ${API_URL}`)
  console.log(`Phone: ${SMOKE_PHONE}`)

  const sendOtp = await requestJson('/auth/otp/send', {
    method: 'POST',
    body: { phone: SMOKE_PHONE }
  })
  assertOk('POST /auth/otp/send', sendOtp)
  console.log('[PASS] POST /auth/otp/send')

  const otpCode = SMOKE_OTP_CODE || sendOtp.json?.debugCode
  if (!otpCode) {
    console.error('Missing OTP code. Set SMOKE_OTP_CODE to the SMS code and retry.')
    process.exit(1)
  }

  const verifyOtp = await requestJson('/auth/otp/verify', {
    method: 'POST',
    body: { phone: SMOKE_PHONE, code: otpCode }
  })
  assertOk('POST /auth/otp/verify', verifyOtp)
  console.log('[PASS] POST /auth/otp/verify')

  const token = verifyOtp.json?.token
  if (!token || typeof token !== 'string') {
    console.error('Verify response did not return a token')
    process.exit(1)
  }

  const me = await requestJson('/users/me', {
    headers: { Authorization: `Bearer ${token}` }
  })
  assertOk('GET /users/me', me)
  console.log('[PASS] GET /users/me')
  console.log(`User: ${me.json?.id} (${me.json?.role})`)

  const rides = await requestJson('/users/me/rides?limit=5', {
    headers: { Authorization: `Bearer ${token}` }
  })
  assertOk('GET /users/me/rides', rides)
  const rideCount = Array.isArray(rides.json?.items) ? rides.json.items.length : 0
  console.log(`[PASS] GET /users/me/rides (items=${rideCount})`)

  console.log('Auth smoke test completed successfully.')
}

run().catch((err) => {
  console.error('[FAIL] Unexpected error')
  console.error(err)
  process.exit(1)
})
