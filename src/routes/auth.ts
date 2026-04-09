import { Router } from 'express'
import { z } from 'zod'
import prisma from '../db.js'
import { checkOtpSendRateLimit, checkOtpVerifyRateLimit, clearOtp, createOtp, recordOtpSendAttempt, signAuthToken, verifyOtpCode } from '../lib/auth.js'
import { isRealSmsProviderConfigured, sendOtpSms } from '../services/sms.js'
import { normalizePhoneForIdentity } from '../lib/phone.js'

const router = Router()

router.post('/otp/send', async (req, res) => {
  const parsed = z.object({ phone: z.string().min(8).max(20) }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }
  const phone = normalizePhoneForIdentity(parsed.data.phone)

  if (process.env.NODE_ENV === 'production' && !isRealSmsProviderConfigured()) {
    return res.status(500).json({ error: 'SMS provider is not configured' })
  }

  const limited = checkOtpSendRateLimit(phone, req.ip)
  if (!limited.ok) {
    const retryAfterSec = Math.max(1, Math.ceil(limited.retryAfterMs / 1000))
    res.setHeader('Retry-After', String(retryAfterSec))
    return res.status(429).json({ error: 'Too many OTP requests. Please try again later.', retryAfterSec })
  }

  const session = createOtp(phone)
  const isProd = process.env.NODE_ENV === 'production'

  try {
    await sendOtpSms(session.phone, session.code)
    recordOtpSendAttempt(phone, req.ip)
  } catch (err) {
    if (isProd) {
      clearOtp(session.phone)
    } else {
      // Dev fallback: keep local login flow usable even when SMS provider is down.
      return res.json({
        ok: true,
        message: 'OTP sent (dev fallback)',
        debugCode: '123456',
        expiresAt: new Date(session.expiresAt).toISOString(),
        warning: err instanceof Error ? err.message : 'Unknown SMS provider error'
      })
    }

    const detail = err instanceof Error ? err.message : 'Unknown SMS provider error'
    return res.status(503).json({
      error: 'Failed to send OTP. Please try again.',
      ...(isProd ? {} : { detail })
    })
  }

  return res.json({
    ok: true,
    message: 'OTP sent',
    ...(isProd ? {} : { debugCode: session.code, expiresAt: new Date(session.expiresAt).toISOString() })
  })
})

router.post('/otp/verify', async (req, res) => {
  const parsed = z.object({ phone: z.string().min(8).max(20), code: z.string().length(6) }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }
  const phone = normalizePhoneForIdentity(parsed.data.phone)

  const verifyLimited = checkOtpVerifyRateLimit(phone)
  if (!verifyLimited.ok) {
    const retryAfterSec = Math.max(1, Math.ceil(verifyLimited.retryAfterMs / 1000))
    res.setHeader('Retry-After', String(retryAfterSec))
    return res.status(429).json({ error: 'Too many OTP verification attempts. Please try again later.', retryAfterSec })
  }

  const otpResult = verifyOtpCode(phone, parsed.data.code)
  if (!otpResult.ok) {
    return res.status(401).json({ error: otpResult.reason })
  }

  const user = await prisma.user.upsert({
    where: { phone: otpResult.phone },
    update: {},
    create: {
      phone: otpResult.phone,
      name: `User ${otpResult.phone.slice(-4)}`,
      role: 'PASSENGER'
    }
  })

  const token = signAuthToken({
    userId: user.id,
    phone: user.phone,
    role: user.role
  })

  return res.json({ ok: true, token })
})

router.post('/register', async (req, res) => {
  const parsed = z.object({
    name: z.string().min(2).max(80),
    phone: z.string().min(8).max(20),
    email: z.string().email().optional()
  }).safeParse(req.body)
  if (!parsed.success) {
    return res.status(422).json({ error: parsed.error.flatten() })
  }
  const phone = normalizePhoneForIdentity(parsed.data.phone)

  const user = await prisma.user.upsert({
    where: { phone },
    update: {
      name: parsed.data.name,
      email: parsed.data.email
    },
    create: {
      name: parsed.data.name,
      phone,
      email: parsed.data.email,
      role: 'PASSENGER'
    }
  })

  return res.json({ ok: true, userId: user.id })
})

export default router
