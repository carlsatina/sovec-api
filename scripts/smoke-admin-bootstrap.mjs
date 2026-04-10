#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const API_URL = process.env.API_URL ?? 'http://localhost:4000'
const BOOTSTRAP_PHONE = process.env.BOOTSTRAP_PHONE
const SMOKE_OTP_CODE = process.env.SMOKE_OTP_CODE

if (!BOOTSTRAP_PHONE) {
  console.error('Missing BOOTSTRAP_PHONE. Example: BOOTSTRAP_PHONE=+639171111111 SMOKE_SUITES=admin-bootstrap npm run smoke')
  process.exit(1)
}

function runBootstrapCommand() {
  const result = spawnSync('npm', ['run', 'admin:bootstrap'], {
    env: process.env,
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    console.error('[FAIL] npm run admin:bootstrap')
    if (result.stdout?.trim()) console.error(result.stdout.trim())
    if (result.stderr?.trim()) console.error(result.stderr.trim())
    process.exit(result.status ?? 1)
  }

  console.log('[PASS] npm run admin:bootstrap')
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
  console.log(`Running admin bootstrap smoke test against ${API_URL}`)
  console.log(`Phone: ${BOOTSTRAP_PHONE}`)

  runBootstrapCommand()

  const sendOtp = await requestJson('/auth/otp/send', {
    method: 'POST',
    body: { phone: BOOTSTRAP_PHONE }
  })
  assertOk('POST /auth/otp/send', sendOtp)
  console.log('[PASS] POST /auth/otp/send')

  const otpCode = SMOKE_OTP_CODE || sendOtp.json?.debugCode
  if (!otpCode) {
    console.error('[FAIL] Missing OTP code. Set SMOKE_OTP_CODE when using real SMS providers.')
    process.exit(1)
  }

  const verifyOtp = await requestJson('/auth/otp/verify', {
    method: 'POST',
    body: { phone: BOOTSTRAP_PHONE, code: otpCode }
  })
  assertOk('POST /auth/otp/verify', verifyOtp)
  console.log('[PASS] POST /auth/otp/verify')

  const token = verifyOtp.json?.token
  if (!token) {
    console.error('[FAIL] OTP verify response missing token')
    process.exit(1)
  }

  const me = await requestJson('/users/me', {
    headers: { Authorization: `Bearer ${token}` }
  })
  assertOk('GET /users/me', me)
  if (me.json?.role !== 'ADMIN') {
    console.error('[FAIL] Expected ADMIN role after bootstrap')
    console.error(me.json)
    process.exit(1)
  }
  console.log('[PASS] GET /users/me (role=ADMIN)')

  console.log('Admin bootstrap smoke test completed successfully.')
}

run().catch((err) => {
  console.error('[FAIL] Unexpected error')
  console.error(err)
  process.exit(1)
})
