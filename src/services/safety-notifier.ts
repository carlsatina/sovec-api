import { sendTextSms } from './sms.js'
import prisma from '../db.js'

export const SAFETY_TEMPLATE_KEYS = ['ESCALATION_ADMIN', 'ESCALATION_REPORTER', 'RESOLUTION_REPORTER'] as const
export type SafetyTemplateKey = (typeof SAFETY_TEMPLATE_KEYS)[number]

export type SafetyTemplate = {
  subject: string
  body: string
}

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

async function sendEmailStub(email: string, subject: string, body: string) {
  console.log(`[email:stub] to=${email} subject=${subject} body=${body}`)
  return { ok: true as const }
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

  const results: Array<{ channel: string; target: string; ok: boolean; error?: string }> = []

  for (const phone of adminPhones) {
    try {
      await sendTextSms(phone, `${adminSubject} - ${adminBody}`)
      results.push({ channel: 'sms', target: phone, ok: true })
    } catch (err) {
      results.push({ channel: 'sms', target: phone, ok: false, error: err instanceof Error ? err.message : 'send failed' })
    }
  }

  for (const email of adminEmails) {
    try {
      await sendEmailStub(email, adminSubject, adminBody)
      results.push({ channel: 'email', target: email, ok: true })
    } catch (err) {
      results.push({ channel: 'email', target: email, ok: false, error: err instanceof Error ? err.message : 'send failed' })
    }
  }

  if (input.reporter?.phone) {
    try {
      await sendTextSms(input.reporter.phone, `${reporterSubject} - ${reporterBody}`)
      results.push({ channel: 'sms', target: input.reporter.phone, ok: true })
    } catch (err) {
      results.push({ channel: 'sms', target: input.reporter.phone, ok: false, error: err instanceof Error ? err.message : 'send failed' })
    }
  }

  if (input.reporter?.email) {
    try {
      await sendEmailStub(input.reporter.email, reporterSubject, reporterBody)
      results.push({ channel: 'email', target: input.reporter.email, ok: true })
    } catch (err) {
      results.push({ channel: 'email', target: input.reporter.email, ok: false, error: err instanceof Error ? err.message : 'send failed' })
    }
  }

  try {
    const webhookResult = await postWebhook({
      event: 'safety.escalated',
      incidentId: input.incidentId,
      priority: input.priority,
      reason: input.reason,
      rideId: input.rideId ?? null
    })
    if (webhookResult.sent) {
      results.push({ channel: 'webhook', target: getWebhookUrl() || 'configured', ok: true })
    }
  } catch (err) {
    results.push({ channel: 'webhook', target: getWebhookUrl() || 'configured', ok: false, error: err instanceof Error ? err.message : 'send failed' })
  }

  return {
    delivered: results.filter((x) => x.ok).length,
    attempted: results.length,
    results
  }
}

export async function notifySafetyResolution(input: {
  incidentId: string
  status: 'RESOLVED' | 'CLOSED'
  action: string
  note?: string | null
  reporter?: { phone?: string | null; email?: string | null }
}) {
  const templates = await getSafetyTemplates()
  const vars = {
    incidentId: input.incidentId,
    status: input.status,
    action: input.action,
    note: input.note ?? ''
  }

  const tpl = templates.RESOLUTION_REPORTER
  const subject = renderTemplate(tpl.subject, vars)
  const body = renderTemplate(tpl.body, vars)

  const results: Array<{ channel: string; target: string; ok: boolean; error?: string }> = []

  if (input.reporter?.phone) {
    try {
      await sendTextSms(input.reporter.phone, `${subject} - ${body}`)
      results.push({ channel: 'sms', target: input.reporter.phone, ok: true })
    } catch (err) {
      results.push({ channel: 'sms', target: input.reporter.phone, ok: false, error: err instanceof Error ? err.message : 'send failed' })
    }
  }

  if (input.reporter?.email) {
    try {
      await sendEmailStub(input.reporter.email, subject, body)
      results.push({ channel: 'email', target: input.reporter.email, ok: true })
    } catch (err) {
      results.push({ channel: 'email', target: input.reporter.email, ok: false, error: err instanceof Error ? err.message : 'send failed' })
    }
  }

  try {
    const webhookResult = await postWebhook({
      event: 'safety.resolved',
      incidentId: input.incidentId,
      status: input.status,
      action: input.action,
      note: input.note ?? null
    })
    if (webhookResult.sent) {
      results.push({ channel: 'webhook', target: getWebhookUrl() || 'configured', ok: true })
    }
  } catch (err) {
    results.push({ channel: 'webhook', target: getWebhookUrl() || 'configured', ok: false, error: err instanceof Error ? err.message : 'send failed' })
  }

  return {
    delivered: results.filter((x) => x.ok).length,
    attempted: results.length,
    results
  }
}
