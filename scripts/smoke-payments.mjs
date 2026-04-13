#!/usr/bin/env node

const API_URL = process.env.API_URL ?? 'http://localhost:4000'
const SMOKE_PHONE = process.env.SMOKE_PHONE
const SMOKE_OTP_CODE = process.env.SMOKE_OTP_CODE
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET
const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER ?? 'mock').trim().toLowerCase()

if (!SMOKE_PHONE) {
  console.error('Missing SMOKE_PHONE. Example: SMOKE_PHONE=+639171111111 npm run smoke')
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

async function ensureAuthToken() {
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
  return token
}

async function resolveRideId(token) {
  const ridesRes = await requestJson('/users/me/rides?limit=5', {
    headers: { Authorization: `Bearer ${token}` }
  })
  assertOk('GET /users/me/rides', ridesRes)

  const rides = Array.isArray(ridesRes.json?.items) ? ridesRes.json.items : []
  const preferred = rides.find((ride) => ride.paymentMethod === 'EWALLET' || ride.paymentMethod === 'CARD') ?? rides[0]
  if (!preferred?.id) {
    console.error('[FAIL] No rides found for this user. Seed rides or book one before running payment smoke.')
    process.exit(1)
  }
  return preferred.id
}

async function run() {
  console.log(`Running payments smoke test against ${API_URL}`)
  console.log(`Phone: ${SMOKE_PHONE}`)

  const token = await ensureAuthToken()
  const rideId = await resolveRideId(token)
  console.log(`[INFO] Using ride id=${rideId}`)

  const charge = await requestJson('/payments/charge', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { rideId, method: 'EWALLET' }
  })
  assertOk('POST /payments/charge', charge)
  console.log('[PASS] POST /payments/charge')

  const reference = charge.json?.payment?.reference
  if (!reference || typeof reference !== 'string') {
    console.error('[FAIL] Payment charge did not return payment.reference')
    process.exit(1)
  }

  if (PAYMENT_PROVIDER === 'mock') {
    const webhook = await requestJson('/payments/webhooks/mock', {
      method: 'POST',
      headers: PAYMENT_WEBHOOK_SECRET
        ? { 'x-payment-webhook-secret': PAYMENT_WEBHOOK_SECRET }
        : undefined,
      body: {
        eventId: `smoke_${Date.now()}`,
        reference,
        status: 'PAID'
      }
    })
    assertOk('POST /payments/webhooks/mock', webhook)
    console.log('[PASS] POST /payments/webhooks/mock')
    console.log(`Payment ${webhook.json?.paymentId} -> ${webhook.json?.status}`)
  } else {
    console.log('[INFO] Provider is paymongo; webhook simulation skipped in local smoke.')
    console.log(`[INFO] Complete checkout using returned URL, then verify via your PayMongo webhook callback.`)
  }

  console.log('Payments smoke test completed successfully.')
}

run().catch((err) => {
  console.error('[FAIL] Unexpected error')
  console.error(err)
  process.exit(1)
})
