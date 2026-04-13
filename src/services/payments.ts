import type { PaymentMethod } from '@prisma/client'
import { createHmac, timingSafeEqual } from 'node:crypto'

export type PaymentState = 'PENDING' | 'PAID' | 'VERIFIED' | 'FAILED' | 'REFUND_PENDING' | 'REFUNDED'
export type PaymentProviderName = 'mock' | 'paymongo'

type CreateChargeInput = {
  paymentId: string
  rideId: string
  amount: number
  currency: string
  method: PaymentMethod
}

type CreateChargeResult = {
  status: PaymentState
  providerReference: string
  checkoutUrl: string | null
  raw?: Record<string, unknown>
}

type WebhookParseResult = {
  eventId: string
  providerReference: string
  status: PaymentState
  paymentId?: string
  raw: Record<string, unknown>
}

type PaymentProvider = {
  name: PaymentProviderName
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>
  parseWebhook(payload: unknown, rawBody?: string): WebhookParseResult
}

const BLOCKED_RECHARGE_STATES: ReadonlyArray<PaymentState> = ['PAID', 'VERIFIED', 'REFUND_PENDING', 'REFUNDED']

const ALLOWED_TRANSITIONS: Record<PaymentState, ReadonlyArray<PaymentState>> = {
  PENDING: ['PAID', 'FAILED'],
  PAID: ['VERIFIED', 'REFUND_PENDING', 'REFUNDED'],
  VERIFIED: ['REFUND_PENDING', 'REFUNDED'],
  FAILED: [],
  REFUND_PENDING: ['REFUNDED'],
  REFUNDED: []
}

function mapState(value: string): PaymentState | null {
  const normalized = value.trim().toUpperCase()
  if (normalized === 'PENDING' || normalized === 'PAID' || normalized === 'VERIFIED' || normalized === 'FAILED' || normalized === 'REFUND_PENDING' || normalized === 'REFUNDED') {
    return normalized
  }
  return null
}

const mockProvider: PaymentProvider = {
  name: 'mock',
  async createCharge(input) {
    if (input.method === 'CASH') {
      return {
        status: 'PAID',
        providerReference: `cash_${input.paymentId}`,
        checkoutUrl: null,
        raw: { provider: 'mock', settlement: 'cash' }
      }
    }

    return {
      status: 'PENDING',
      providerReference: `mock_${input.paymentId}`,
      checkoutUrl: `https://mock-pay.local/checkout/${input.paymentId}`,
      raw: { provider: 'mock', settlement: 'async' }
    }
  },
  parseWebhook(payload: unknown) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid webhook payload')
    }
    const source = payload as Record<string, unknown>
    const providerReference = typeof source.reference === 'string' ? source.reference.trim() : ''
    const rawStatus = typeof source.status === 'string' ? source.status : ''
    const status = mapState(rawStatus)
    const eventId = typeof source.eventId === 'string' ? source.eventId.trim() : ''
    if (!providerReference || !status || !eventId) {
      throw new Error('Invalid webhook payload')
    }
    return {
      eventId,
      providerReference,
      status,
      raw: source
    }
  }
}

function getPaymongoConfig() {
  return {
    secretKey: process.env.PAYMONGO_SECRET_KEY?.trim() ?? '',
    webhookSecret: process.env.PAYMONGO_WEBHOOK_SECRET?.trim() ?? '',
    apiBase: process.env.PAYMONGO_API_BASE?.trim() || 'https://api.paymongo.com',
    apiVersion: process.env.PAYMONGO_CHECKOUT_API_VERSION?.trim() || 'v1',
    successUrl: process.env.PAYMONGO_SUCCESS_URL?.trim() || 'https://example.com/payment/success',
    cancelUrl: process.env.PAYMONGO_CANCEL_URL?.trim() || 'https://example.com/payment/cancel'
  }
}

function toBasicAuthHeader(secretKey: string) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`
}

function paymentMethodTypesFromMethod(method: PaymentMethod) {
  if (method === 'CARD') return ['card']
  if (method === 'EWALLET') return ['gcash', 'paymaya']
  return ['gcash', 'paymaya', 'card']
}

function parsePaymongoSignatureHeader(value: string) {
  const pairs = value.split(',').map((part) => part.trim())
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    if (idx < 0) continue
    const key = pair.slice(0, idx).trim()
    const content = pair.slice(idx + 1).trim()
    if (key) out[key] = content
  }
  return out
}

function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

const paymongoProvider: PaymentProvider = {
  name: 'paymongo',
  async createCharge(input) {
    if (input.method === 'CASH') {
      return {
        status: 'PAID',
        providerReference: `cash_${input.paymentId}`,
        checkoutUrl: null,
        raw: { provider: 'paymongo', settlement: 'cash-manual' }
      }
    }

    const config = getPaymongoConfig()
    if (!config.secretKey) {
      throw new Error('PayMongo provider is not fully configured (missing PAYMONGO_SECRET_KEY)')
    }

    const cents = Math.max(1, Math.round(input.amount * 100))
    const endpoint = `${config.apiBase}/${config.apiVersion}/checkout_sessions`
    const body = {
      data: {
        attributes: {
          line_items: [
            {
              currency: input.currency,
              amount: cents,
              name: `Ride ${input.rideId}`,
              quantity: 1
            }
          ],
          payment_method_types: paymentMethodTypesFromMethod(input.method),
          description: `Ride payment ${input.rideId}`,
          reference_number: input.paymentId,
          success_url: config.successUrl,
          cancel_url: config.cancelUrl,
          metadata: {
            paymentId: input.paymentId,
            rideId: input.rideId
          }
        }
      }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: toBasicAuthHeader(config.secretKey),
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`PayMongo create checkout failed (${res.status}): ${text}`)
    }

    const json = await res.json() as {
      data?: {
        id?: string
        attributes?: {
          checkout_url?: string
          status?: string
        }
      }
    }

    const checkoutId = json.data?.id
    const checkoutUrl = json.data?.attributes?.checkout_url ?? null
    if (!checkoutId || typeof checkoutId !== 'string') {
      throw new Error(`PayMongo did not return checkout session id: ${JSON.stringify(json)}`)
    }

    return {
      status: 'PENDING',
      providerReference: checkoutId,
      checkoutUrl: typeof checkoutUrl === 'string' ? checkoutUrl : null,
      raw: json as unknown as Record<string, unknown>
    }
  },
  parseWebhook(payload: unknown, rawBody?: string) {
    const config = getPaymongoConfig()
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid webhook payload')
    }

    const root = payload as Record<string, unknown>
    const dataObj = (root.data && typeof root.data === 'object') ? root.data as Record<string, unknown> : null
    const attrs = (dataObj?.attributes && typeof dataObj.attributes === 'object') ? dataObj.attributes as Record<string, unknown> : null
    const eventType = typeof attrs?.type === 'string' ? attrs.type : ''
    const eventPayload = (attrs?.data && typeof attrs.data === 'object') ? attrs.data as Record<string, unknown> : null
    const metadata = (eventPayload?.attributes && typeof eventPayload.attributes === 'object')
      ? ((eventPayload.attributes as Record<string, unknown>).metadata as Record<string, unknown> | undefined)
      : undefined

    const eventId = typeof dataObj?.id === 'string' ? dataObj.id : ''
    const providerReference = typeof eventPayload?.id === 'string' ? eventPayload.id : ''
    const liveMode = Boolean(attrs?.livemode)
    const paymentId = typeof metadata?.paymentId === 'string' ? metadata.paymentId : undefined

    let status: PaymentState | null = null
    if (eventType === 'checkout_session.payment.paid' || eventType === 'payment.paid' || eventType === 'link.payment.paid') {
      status = 'PAID'
    } else if (eventType === 'payment.failed' || eventType === 'checkout_session.payment.failed') {
      status = 'FAILED'
    }

    if (!eventId || !providerReference || !status) {
      throw new Error(`Unsupported webhook event payload (${eventType || 'unknown'})`)
    }

    if (config.webhookSecret) {
      if (!rawBody) {
        throw new Error('Missing raw webhook body for signature verification')
      }
      const signatureHeaderRaw = typeof root.__signatureHeader === 'string' ? root.__signatureHeader : ''
      if (!signatureHeaderRaw) {
        throw new Error('Missing PayMongo signature header')
      }
      const parts = parsePaymongoSignatureHeader(signatureHeaderRaw)
      const timestamp = parts.t
      const expected = liveMode ? parts.li : parts.te
      if (!timestamp || !expected) {
        throw new Error('Invalid PayMongo signature header')
      }
      const signedPayload = `${timestamp}.${rawBody}`
      const computed = createHmac('sha256', config.webhookSecret).update(signedPayload, 'utf8').digest('hex')
      if (!constantTimeEquals(computed, expected)) {
        throw new Error('Invalid PayMongo webhook signature')
      }
    }

    return {
      eventId,
      providerReference,
      status,
      paymentId,
      raw: root
    }
  }
}

export function getPaymentProvider(): PaymentProvider {
  const selected = (process.env.PAYMENT_PROVIDER ?? 'mock').trim().toLowerCase()
  if (selected === 'paymongo') return paymongoProvider
  return mockProvider
}

export function canRechargeFromStatus(status: string) {
  return !BLOCKED_RECHARGE_STATES.includes(status as PaymentState)
}

export function canTransitionPaymentStatus(current: string, next: string) {
  const from = mapState(current)
  const to = mapState(next)
  if (!from || !to) return false
  if (from === to) return true
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function isPaymentWebhookAuthorized(headers: Record<string, string | string[] | undefined>, provider: PaymentProviderName) {
  if (provider === 'paymongo') {
    const signatureHeader = headers['paymongo-signature']
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
    const hasSignature = typeof signature === 'string' && signature.trim().length > 0
    const config = getPaymongoConfig()
    if (process.env.NODE_ENV === 'production' && !config.webhookSecret) {
      return false
    }
    return hasSignature
  }

  const configured = process.env.PAYMENT_WEBHOOK_SECRET?.trim()
  if (!configured) return process.env.NODE_ENV !== 'production'

  const incomingHeader = headers['x-payment-webhook-secret']
  const incoming = Array.isArray(incomingHeader) ? incomingHeader[0] : incomingHeader
  return typeof incoming === 'string' && incoming.trim() === configured
}
