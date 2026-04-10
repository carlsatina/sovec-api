import { sendTextSms } from './sms.js'
import prisma from '../db.js'
import { sendEmail } from './email.js'
import type { Prisma } from '@prisma/client'

export const SAFETY_TEMPLATE_KEYS = ['ESCALATION_ADMIN', 'ESCALATION_REPORTER', 'RESOLUTION_REPORTER'] as const
export type SafetyTemplateKey = (typeof SAFETY_TEMPLATE_KEYS)[number]

export type SafetyTemplate = {
  subject: string
  body: string
}

type DeliveryEvent = 'safety.escalated' | 'safety.resolved'
type DeliveryChannel = 'sms' | 'email' | 'webhook'
const DELIVERY_EVENTS: DeliveryEvent[] = ['safety.escalated', 'safety.resolved']
const DELIVERY_CHANNELS: DeliveryChannel[] = ['sms', 'email', 'webhook']

const defaultTemplates: Record<SafetyTemplateKey, SafetyTemplate> = {
  ESCALATION_ADMIN: {
    subject: 'Safety Escalation {{incidentId}} ({{priority}})',
    body: 'Incident {{incidentId}} has been escalated to {{priority}}. Reason: {{reason}}. Ride: {{rideId}}.'
  },
  ESCALATION_REPORTER: {
    subject: 'Your Safety Incident Is Escalated',
    body: 'Your incident {{incidentId}} is now {{priority}} priority. The team is actively handling this case.'
  },
  RESOLUTION_REPORTER: {
    subject: 'Safety Incident {{incidentId}} Update',
    body: 'Your safety incident {{incidentId}} was marked {{status}}. Action: {{action}}. Note: {{note}}.'
  }
}

function renderTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => vars[key] ?? '')
}

function parseCsv(value?: string) {
  if (!value) return []
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function getWebhookUrl() {
  const value = process.env.SAFETY_ESCALATION_WEBHOOK_URL?.trim()
  return value || null
}

function getRetryConfig() {
  const maxAttemptsRaw = Number(process.env.SAFETY_DELIVERY_MAX_ATTEMPTS ?? 3)
  const retryDelayRaw = Number(process.env.SAFETY_DELIVERY_RETRY_DELAY_MS ?? 250)
  const maxAttempts = Number.isFinite(maxAttemptsRaw) ? Math.max(1, Math.min(10, Math.floor(maxAttemptsRaw))) : 3
  const retryDelayMs = Number.isFinite(retryDelayRaw) ? Math.max(0, Math.min(10_000, Math.floor(retryDelayRaw))) : 250
  return { maxAttempts, retryDelayMs }
}

async function waitMs(ms: number) {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureDefaultTemplates() {
  await Promise.all(
    SAFETY_TEMPLATE_KEYS.map((key) => prisma.safetyTemplate.upsert({
      where: { key },
      update: {},
      create: {
        key,
        subject: defaultTemplates[key].subject,
        body: defaultTemplates[key].body
      }
    }))
  )
}

export async function getSafetyTemplates(): Promise<Record<SafetyTemplateKey, SafetyTemplate>> {
  await ensureDefaultTemplates()
  const rows = await prisma.safetyTemplate.findMany({
    where: { key: { in: [...SAFETY_TEMPLATE_KEYS] } }
  })

  const table = new Map(rows.map((row: { key: string; subject: string; body: string }) => [row.key as SafetyTemplateKey, { subject: row.subject, body: row.body }]))
  return {
    ESCALATION_ADMIN: table.get('ESCALATION_ADMIN') ?? { ...defaultTemplates.ESCALATION_ADMIN },
    ESCALATION_REPORTER: table.get('ESCALATION_REPORTER') ?? { ...defaultTemplates.ESCALATION_REPORTER },
    RESOLUTION_REPORTER: table.get('RESOLUTION_REPORTER') ?? { ...defaultTemplates.RESOLUTION_REPORTER }
  }
}

export async function updateSafetyTemplate(key: SafetyTemplateKey, update: Partial<SafetyTemplate>) {
  await ensureDefaultTemplates()
  const defaults = defaultTemplates[key]
  const existing = await prisma.safetyTemplate.findUnique({ where: { key } })
  const next = {
    subject: (update.subject ?? existing?.subject ?? defaults.subject).trim(),
    body: (update.body ?? existing?.body ?? defaults.body).trim()
  }
  const saved = await prisma.safetyTemplate.upsert({
    where: { key },
    update: next,
    create: {
      key,
      ...next
    }
  })
  return {
    subject: saved.subject,
    body: saved.body
  }
}

export function resetSafetyTemplatesForTests() {
  // No-op now that templates are persisted in DB.
}

async function createSafetyDeliveryLog(data: {
  incidentId: string
  event: DeliveryEvent
  channel: DeliveryChannel
  target: string
  status: 'DELIVERED' | 'DEAD_LETTER'
  attempts: number
  lastError?: string
  payload?: Prisma.JsonValue
}) {
  const repo = (prisma as any).safetyDeliveryLog
  if (!repo?.create) return
  await repo.create({
    data: {
      incidentId: data.incidentId,
      event: data.event,
      channel: data.channel,
      target: data.target,
      status: data.status,
      attempts: data.attempts,
      lastError: data.lastError ?? null,
      payload: data.payload ?? null,
      deliveredAt: data.status === 'DELIVERED' ? new Date() : null,
      deadLetteredAt: data.status === 'DEAD_LETTER' ? new Date() : null
    }
  }).catch((err: unknown) => {
    console.error('[safety-delivery-log] failed to persist', {
      incidentId: data.incidentId,
      event: data.event,
      channel: data.channel,
      target: data.target,
      status: data.status,
      error: err instanceof Error ? err.message : String(err)
    })
  })
}

async function deliverWithRetry(input: {
  incidentId: string
  event: DeliveryEvent
  channel: DeliveryChannel
  target: string
  payload?: Prisma.JsonValue
  send: () => Promise<void>
}) {
  const { maxAttempts, retryDelayMs } = getRetryConfig()
  let attempts = 0
  let lastError: string | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt
    try {
      await input.send()
      await createSafetyDeliveryLog({
        incidentId: input.incidentId,
        event: input.event,
        channel: input.channel,
        target: input.target,
        status: 'DELIVERED',
        attempts,
        payload: input.payload
      })
      return { channel: input.channel, target: input.target, ok: true as const, attempts }
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'send failed'
      if (attempt < maxAttempts) {
        await waitMs(retryDelayMs * attempt)
      }
    }
  }

  await createSafetyDeliveryLog({
    incidentId: input.incidentId,
    event: input.event,
    channel: input.channel,
    target: input.target,
    status: 'DEAD_LETTER',
    attempts,
    lastError,
    payload: input.payload
  })

  return { channel: input.channel, target: input.target, ok: false as const, attempts, error: lastError }
}

function asRecord(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

async function postWebhook(payload: Record<string, unknown>) {
  const url = getWebhookUrl()
  if (!url) return { sent: false as const }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Webhook failed (${res.status}): ${text}`)
  }

  return { sent: true as const }
}

export async function notifySafetyEscalation(input: {
  incidentId: string
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  reason: string
  rideId?: string | null
  reporter?: { name?: string | null; phone?: string | null; email?: string | null }
}) {
  const templates = await getSafetyTemplates()
  const event: DeliveryEvent = 'safety.escalated'
  const vars = {
    incidentId: input.incidentId,
    priority: input.priority,
    reason: input.reason,
    rideId: input.rideId ?? 'N/A'
  }

  const adminTpl = templates.ESCALATION_ADMIN
  const reporterTpl = templates.ESCALATION_REPORTER
  const adminSubject = renderTemplate(adminTpl.subject, vars)
  const adminBody = renderTemplate(adminTpl.body, vars)
  const reporterSubject = renderTemplate(reporterTpl.subject, vars)
  const reporterBody = renderTemplate(reporterTpl.body, vars)

  const adminPhones = parseCsv(process.env.SAFETY_ESCALATION_PHONES)
  const adminEmails = parseCsv(process.env.SAFETY_ESCALATION_EMAILS)

  const results: Array<{ channel: string; target: string; ok: boolean; attempts: number; error?: string }> = []

  for (const phone of adminPhones) {
    const message = `${adminSubject} - ${adminBody}`
    results.push(await deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'sms',
      target: phone,
      payload: { message, audience: 'admin' },
      send: async () => {
        await sendTextSms(phone, message)
      }
    }))
  }

  for (const email of adminEmails) {
    results.push(await deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'email',
      target: email,
      payload: { subject: adminSubject, body: adminBody, audience: 'admin' },
      send: async () => {
        await sendEmail(email, adminSubject, adminBody)
      }
    }))
  }

  if (input.reporter?.phone) {
    const message = `${reporterSubject} - ${reporterBody}`
    results.push(await deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'sms',
      target: input.reporter.phone,
      payload: { message, audience: 'reporter' },
      send: async () => {
        await sendTextSms(input.reporter!.phone!, message)
      }
    }))
  }

  if (input.reporter?.email) {
    results.push(await deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'email',
      target: input.reporter.email,
      payload: { subject: reporterSubject, body: reporterBody, audience: 'reporter' },
      send: async () => {
        await sendEmail(input.reporter!.email!, reporterSubject, reporterBody)
      }
    }))
  }

  const webhookPayload = {
    event,
    incidentId: input.incidentId,
    priority: input.priority,
    reason: input.reason,
    rideId: input.rideId ?? null
  }
  if (getWebhookUrl()) {
    const target = getWebhookUrl() || 'configured'
    results.push(await deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'webhook',
      target,
      payload: webhookPayload,
      send: async () => {
        const webhookResult = await postWebhook(webhookPayload)
        if (!webhookResult.sent) {
          throw new Error('Webhook URL not configured')
        }
      }
    }))
  } else {
    await createSafetyDeliveryLog({
      incidentId: input.incidentId,
      event,
      channel: 'webhook',
      target: 'not-configured',
      status: 'DEAD_LETTER',
      attempts: 1,
      lastError: 'Webhook URL not configured',
      payload: webhookPayload
    })
    results.push({ channel: 'webhook', target: 'not-configured', ok: false, attempts: 1, error: 'Webhook URL not configured' })
  }

  return {
    delivered: results.filter((x) => x.ok).length,
    attempted: results.length,
    deadLetters: results.filter((x) => !x.ok).length,
    results
  }
}

export async function retrySafetyDeliveryLog(input: {
  incidentId: string
  event: string
  channel: string
  target: string
  payload?: Prisma.JsonValue | null
}) {
  if (!DELIVERY_EVENTS.includes(input.event as DeliveryEvent)) {
    throw new Error(`Unsupported delivery event: ${input.event}`)
  }
  if (!DELIVERY_CHANNELS.includes(input.channel as DeliveryChannel)) {
    throw new Error(`Unsupported delivery channel: ${input.channel}`)
  }
  const event = input.event as DeliveryEvent
  const channel = input.channel as DeliveryChannel
  const payload = asRecord(input.payload)

  if (channel === 'sms') {
    const message = String(payload?.message ?? payload?.body ?? 'Safety notification')
    return deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'sms',
      target: input.target,
      payload: (payload ?? { message }) as Prisma.JsonValue,
      send: async () => {
        await sendTextSms(input.target, message)
      }
    })
  }

  if (channel === 'email') {
    const subject = String(payload?.subject ?? 'Safety Notification')
    const body = String(payload?.body ?? payload?.message ?? 'Safety notification')
    return deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'email',
      target: input.target,
      payload: (payload ?? { subject, body }) as Prisma.JsonValue,
      send: async () => {
        await sendEmail(input.target, subject, body)
      }
    })
  }

  const webhookPayload = payload ?? {}
  return deliverWithRetry({
    incidentId: input.incidentId,
    event,
    channel: 'webhook',
    target: input.target,
    payload: webhookPayload as Prisma.JsonValue,
    send: async () => {
      const result = await postWebhook(webhookPayload)
      if (!result.sent) {
        throw new Error('Webhook URL not configured')
      }
    }
  })
}

export async function notifySafetyResolution(input: {
  incidentId: string
  status: 'RESOLVED' | 'CLOSED'
  action: string
  note?: string | null
  reporter?: { phone?: string | null; email?: string | null }
}) {
  const templates = await getSafetyTemplates()
  const event: DeliveryEvent = 'safety.resolved'
  const vars = {
    incidentId: input.incidentId,
    status: input.status,
    action: input.action,
    note: input.note ?? ''
  }

  const tpl = templates.RESOLUTION_REPORTER
  const subject = renderTemplate(tpl.subject, vars)
  const body = renderTemplate(tpl.body, vars)

  const results: Array<{ channel: string; target: string; ok: boolean; attempts: number; error?: string }> = []

  if (input.reporter?.phone) {
    const message = `${subject} - ${body}`
    results.push(await deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'sms',
      target: input.reporter.phone,
      payload: { message, audience: 'reporter' },
      send: async () => {
        await sendTextSms(input.reporter!.phone!, message)
      }
    }))
  }

  if (input.reporter?.email) {
    results.push(await deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'email',
      target: input.reporter.email,
      payload: { subject, body, audience: 'reporter' },
      send: async () => {
        await sendEmail(input.reporter!.email!, subject, body)
      }
    }))
  }

  const webhookPayload = {
    event,
    incidentId: input.incidentId,
    status: input.status,
    action: input.action,
    note: input.note ?? null
  }
  if (getWebhookUrl()) {
    const target = getWebhookUrl() || 'configured'
    results.push(await deliverWithRetry({
      incidentId: input.incidentId,
      event,
      channel: 'webhook',
      target,
      payload: webhookPayload,
      send: async () => {
        const webhookResult = await postWebhook(webhookPayload)
        if (!webhookResult.sent) {
          throw new Error('Webhook URL not configured')
        }
      }
    }))
  } else {
    await createSafetyDeliveryLog({
      incidentId: input.incidentId,
      event,
      channel: 'webhook',
      target: 'not-configured',
      status: 'DEAD_LETTER',
      attempts: 1,
      lastError: 'Webhook URL not configured',
      payload: webhookPayload
    })
    results.push({ channel: 'webhook', target: 'not-configured', ok: false, attempts: 1, error: 'Webhook URL not configured' })
  }

  return {
    delivered: results.filter((x) => x.ok).length,
    attempted: results.length,
    deadLetters: results.filter((x) => !x.ok).length,
    results
  }
}
