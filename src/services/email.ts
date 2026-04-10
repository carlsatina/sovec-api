type EmailProvider = 'stub' | 'resend'

type EmailConfig = {
  provider: EmailProvider
  resendApiKey?: string
  resendFromEmail?: string
}

function getEmailConfig(): EmailConfig {
  const provider = (process.env.EMAIL_PROVIDER ?? 'stub').trim().toLowerCase()
  if (provider === 'resend') {
    return {
      provider: 'resend',
      resendApiKey: process.env.RESEND_API_KEY?.trim(),
      resendFromEmail: process.env.RESEND_FROM_EMAIL?.trim()
    }
  }
  return { provider: 'stub' }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function sendEmail(to: string, subject: string, body: string) {
  const config = getEmailConfig()
  if (config.provider === 'stub') {
    console.log(`[email:stub] to=${to} subject=${subject} body=${body}`)
    return { provider: 'stub' as const, id: 'stub' }
  }

  const apiKey = config.resendApiKey
  const from = config.resendFromEmail
  if (!apiKey || !from) {
    throw new Error('Resend email provider is not fully configured')
  }

  const html = `<div style="font-family:Arial,sans-serif;line-height:1.5">${escapeHtml(body).replace(/\n/g, '<br/>')}</div>`
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text: body,
      html
    })
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Resend send failed (${res.status}): ${text}`)
  }

  const json = await res.json() as { id?: string; error?: { message?: string } }
  if (!json.id) {
    throw new Error(`Resend did not return message id: ${JSON.stringify(json)}`)
  }

  return { provider: 'resend' as const, id: json.id }
}
