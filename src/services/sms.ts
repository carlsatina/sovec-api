import { toSemaphoreNumber } from '../lib/phone'

type SmsProvider = 'mock' | 'semaphore'

type SmsConfig = {
  provider: SmsProvider
  semaphoreApiKey?: string
  semaphoreSenderName?: string
  semaphoreOtpMessage?: string
}

function getSmsConfig(): SmsConfig {
  const provider = (process.env.SMS_PROVIDER ?? 'mock').trim().toLowerCase()
  if (provider === 'semaphore') {
    return {
      provider: 'semaphore',
      semaphoreApiKey: process.env.SEMAPHORE_API_KEY?.trim(),
      semaphoreSenderName: process.env.SEMAPHORE_SENDER_NAME?.trim(),
      semaphoreOtpMessage: process.env.SEMAPHORE_OTP_MESSAGE?.trim()
    }
  }
  return { provider: 'mock' }
}

export function isRealSmsProviderConfigured() {
  const config = getSmsConfig()
  if (config.provider !== 'semaphore') return false
  return Boolean(config.semaphoreApiKey)
}

export async function sendOtpSms(phone: string, code: string) {
  const config = getSmsConfig()
  if (config.provider === 'mock') {
    console.log(`[sms:mock] OTP ${code} -> ${phone}`)
    return { provider: 'mock' as const, sid: 'mock' }
  }

  const apiKey = config.semaphoreApiKey
  if (!apiKey) {
    throw new Error('Semaphore SMS provider is not fully configured')
  }

  const number = toSemaphoreNumber(phone)
  const message = config.semaphoreOtpMessage || 'Your E-Ride OTP is {otp}. It expires in 5 minutes.'
  const body = new URLSearchParams({
    apikey: apiKey,
    number,
    message,
    code,
    otp: code
  })
  if (config.semaphoreSenderName) {
    body.set('sendername', config.semaphoreSenderName)
  }

  const res = await fetch('https://api.semaphore.co/api/v4/otp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Semaphore send failed (${res.status}): ${text}`)
  }

  const json = await res.json() as
    | Array<{ message_id?: number; status?: string; recipient?: string; code?: number | string }>
    | { message_id?: number; status?: string; recipient?: string; code?: number | string; error?: string; message?: string }

  const first = Array.isArray(json) ? json[0] : json
  if (!first) {
    throw new Error(`Semaphore did not return a message payload: ${JSON.stringify(json)}`)
  }

  const status = String(first.status ?? '').toLowerCase()
  const providerError = (first as { error?: string; message?: string }).error ?? (first as { error?: string; message?: string }).message
  if (status === 'failed' || status === 'rejected') {
    throw new Error(`Semaphore rejected OTP: ${providerError ?? JSON.stringify(first)}`)
  }
  return { provider: 'semaphore' as const, sid: String(first.message_id ?? '') }
}
