import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { getAuthContext, requireAuth } from '../lib/auth.js'
import { canRechargeFromStatus, canTransitionPaymentStatus, getPaymentProvider, isPaymentWebhookAuthorized } from '../services/payments.js'

const router = Router()
const PAYMENT_METHODS = ['CASH', 'EWALLET', 'CARD'] as const
const PAYMENT_STATES = ['PENDING', 'PAID', 'VERIFIED', 'FAILED', 'REFUND_PENDING', 'REFUNDED'] as const

function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

router.get('/methods', (_req, res) => {
  res.json({ methods: ['CASH', 'EWALLET', 'CARD'] })
})

router.post('/charge', requireAuth, async (req, res) => {
  const parsed = z.object({
    rideId: z.string().min(3),
    method: z.enum(PAYMENT_METHODS).optional(),
    amount: z.number().positive().optional()
  }).safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const auth = getAuthContext(res)
  const ride = await prisma.ride.findUnique({
    where: { id: parsed.data.rideId },
    select: {
      id: true,
      riderId: true,
      fareAmount: true,
      currency: true,
      paymentMethod: true
    }
  })
  if (!ride) return res.status(404).json({ error: 'Ride not found' })
  if (ride.riderId !== auth.userId) return res.status(403).json({ error: 'You can only charge your own ride' })

  const existing = await prisma.payment.findUnique({
    where: { rideId: ride.id },
    select: { id: true, status: true, reference: true }
  })
  if (existing && !canRechargeFromStatus(existing.status)) {
    return res.status(409).json({
      error: `Cannot create new charge for payment in ${existing.status} state`,
      paymentId: existing.id,
      status: existing.status
    })
  }

  const method = parsed.data.method ?? ride.paymentMethod
  const amount = parsed.data.amount ?? ride.fareAmount
  const provider = getPaymentProvider()

  const payment = await prisma.payment.upsert({
    where: { rideId: ride.id },
    update: {
      method,
      amount,
      status: 'PENDING'
    },
    create: {
      rideId: ride.id,
      userId: auth.userId,
      method,
      amount,
      status: 'PENDING'
    }
  })

  const charge = await provider.createCharge({
    paymentId: payment.id,
    rideId: ride.id,
    amount,
    currency: ride.currency,
    method
  })

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: charge.status,
      reference: charge.providerReference
    }
  })

  await prisma.rideEvent.create({
    data: {
      rideId: ride.id,
      type: 'PAYMENT_CHARGE_INITIATED',
      metadata: {
        paymentId: updated.id,
        provider: provider.name,
        status: updated.status,
        reference: updated.reference,
        method: updated.method
      }
    }
  }).catch(() => null)

  return res.json({
    ok: true,
    payment: updated,
    provider: provider.name,
    checkoutUrl: charge.checkoutUrl
  })
})

router.get('/receipts/:rideId', (req, res) => {
  res.json({ rideId: req.params.rideId, receiptUrl: null })
})

router.post('/webhooks/:provider', async (req, res) => {
  const parsedParams = z.object({ provider: z.string().trim().min(1) }).safeParse(req.params)
  if (!parsedParams.success) return res.status(422).json({ error: parsedParams.error.flatten() })
  const provider = getPaymentProvider()
  if (parsedParams.data.provider.toLowerCase() !== provider.name) {
    return res.status(404).json({ error: `Webhook provider '${parsedParams.data.provider}' not configured` })
  }

  if (!isPaymentWebhookAuthorized(req.headers as Record<string, string | string[] | undefined>, provider.name)) {
    return res.status(401).json({ error: 'Webhook authorization failed' })
  }

  let event: { eventId: string, providerReference: string, status: (typeof PAYMENT_STATES)[number], paymentId?: string, raw: Record<string, unknown> }
  try {
    const signatureHeader = req.headers['paymongo-signature']
    const normalizedSignature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
    const withSignature = {
      ...(req.body as Record<string, unknown>),
      __signatureHeader: normalizedSignature
    }
    event = provider.parseWebhook(withSignature, (req as any).rawBody)
  } catch (err) {
    return res.status(422).json({
      error: 'Invalid webhook payload',
      detail: err instanceof Error ? err.message : String(err)
    })
  }

  const payment = await prisma.payment.findFirst({
    where: event.paymentId
      ? {
        OR: [
          { id: event.paymentId },
          { reference: event.providerReference }
        ]
      }
      : { reference: event.providerReference },
    select: { id: true, rideId: true, status: true, reference: true }
  })
  if (!payment) return res.status(404).json({ error: 'Payment not found for reference' })

  if (payment.status === event.status) {
    return res.json({ ok: true, applied: false, reason: 'already_in_state', paymentId: payment.id, status: payment.status })
  }
  if (!canTransitionPaymentStatus(payment.status, event.status)) {
    return res.status(409).json({
      error: `Invalid payment status transition (${payment.status} -> ${event.status})`,
      paymentId: payment.id,
      status: payment.status
    })
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.payment.update({
      where: { id: payment.id },
      data: { status: event.status }
    })

    const metadata: Prisma.InputJsonValue = {
      paymentId: payment.id,
      provider: provider.name,
      eventId: event.eventId,
      reference: event.providerReference,
      previousStatus: payment.status,
      nextStatus: event.status,
      raw: toInputJsonValue(event.raw)
    }

    await tx.rideEvent.create({
      data: {
        rideId: payment.rideId,
        type: 'PAYMENT_WEBHOOK_STATUS_CHANGED',
        metadata
      }
    }).catch(() => null)

    return next
  })

  return res.json({
    ok: true,
    applied: true,
    paymentId: updated.id,
    status: updated.status
  })
})

export default router
