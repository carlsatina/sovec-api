#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const API_URL = process.env.API_URL ?? 'http://localhost:4000'
const suitesRaw = process.env.SMOKE_SUITES?.trim()

const allSuites = [
  { key: 'auth', label: 'Auth', file: 'smoke-auth.mjs', enabledByDefault: Boolean(process.env.SMOKE_PHONE) },
  { key: 'admin-fleet', label: 'Admin Fleet', file: 'smoke-admin-fleet.mjs', enabledByDefault: Boolean(process.env.ADMIN_TOKEN) },
  { key: 'admin-support', label: 'Admin Support', file: 'smoke-admin-support.mjs', enabledByDefault: Boolean(process.env.ADMIN_TOKEN) },
  { key: 'admin-analytics', label: 'Admin Analytics', file: 'smoke-admin-analytics.mjs', enabledByDefault: Boolean(process.env.ADMIN_TOKEN) },
  { key: 'admin-safety', label: 'Admin Safety', file: 'smoke-admin-safety.mjs', enabledByDefault: Boolean(process.env.ADMIN_TOKEN) }
]

const selectedKeys = suitesRaw
  ? suitesRaw.split(',').map((x) => x.trim()).filter(Boolean)
  : allSuites.filter((suite) => suite.enabledByDefault).map((suite) => suite.key)

if (selectedKeys.length === 0) {
  console.error('No smoke suites selected.')
  console.error('Set SMOKE_PHONE and/or ADMIN_TOKEN, or use SMOKE_SUITES=auth,admin-fleet,admin-support,admin-analytics,admin-safety')
  process.exit(1)
}

const unknownKeys = selectedKeys.filter((key) => !allSuites.some((suite) => suite.key === key))
if (unknownKeys.length > 0) {
  console.error(`Unknown suite(s): ${unknownKeys.join(', ')}`)
  console.error('Valid suites: auth, admin-fleet, admin-support, admin-analytics, admin-safety')
  process.exit(1)
}

const selectedSuites = selectedKeys.map((key) => allSuites.find((suite) => suite.key === key))

console.log(`Running smoke suites against ${API_URL}`)
console.log(`Suites: ${selectedKeys.join(', ')}`)

for (const suite of selectedSuites) {
  const scriptPath = path.join(__dirname, suite.file)
  console.log(`\n=== ${suite.label} (${suite.key}) ===`)

  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
    env: process.env
  })

  if (result.status !== 0) {
    console.error(`\n[FAIL] Suite failed: ${suite.key}`)
    process.exit(result.status ?? 1)
  }
}

console.log('\nAll selected smoke suites passed.')
