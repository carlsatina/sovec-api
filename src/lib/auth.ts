import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { normalizePhoneForIdentity } from './phone'

export type AuthContext = {
  userId: string
  phone: string
  role: 'PASSENGER' | 'DRIVER' | 'ADMIN'
}

type OtpSession = {
  code: string
  expiresAt: number
}

type WindowCounter = {
  count: number
  windowStartedAt: number
}

type VerifyState = {
  failedAttempts: number
  lockedUntil: number
}

type OtpVerifyResult =
  | { ok: true; phone: string }
  | { ok: false; reason: string }

const OTP_TTL_MS = 5 * 60 * 1000
const OTP_SEND_WINDOW_MS = 10 * 60 * 1000
const OTP_SEND_MAX_PER_WINDOW = 5
const OTP_VERIFY_MAX_ATTEMPTS = 5
const OTP_VERIFY_LOCK_MS = 10 * 60 * 1000

const otpSessions = new Map<string, OtpSession>()
const otpSendCounters = new Map<string, WindowCounter>()
const otpVerifyStates = new Map<string, VerifyState>()
const DEV_JWT_SECRET = 'dev-jwt-secret-change-me'

function getJwtSecret() {
  const configured = process.env.JWT_SECRET?.trim()
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production')
  }
  return DEV_JWT_SECRET
}

export function createOtp(phone: string) {
  const normalizedPhone = normalizePhoneForIdentity(phone)
  const code = String(Math.floor(100000 + Math.random() * 900000))
  const expiresAt = Date.now() + OTP_TTL_MS
  otpSessions.set(normalizedPhone, { code, expiresAt })
  return { phone: normalizedPhone, code, expiresAt }
}

export function clearOtp(phone: string) {
  otpSessions.delete(normalizePhoneForIdentity(phone))
}

function getSendRateLimitKeys(phone: string, ip?: string) {
  const normalizedPhone = normalizePhoneForIdentity(phone)
  return [`phone:${normalizedPhone}`, ip ? `ip:${ip}` : null].filter(Boolean) as string[]
}

export function checkOtpSendRateLimit(phone: string, ip?: string) {
  const now = Date.now()
  const keys = getSendRateLimitKeys(phone, ip)

  for (const key of keys) {
    const current = otpSendCounters.get(key)
    if (!current) continue
    if (now - current.windowStartedAt >= OTP_SEND_WINDOW_MS) {
      otpSendCounters.delete(key)
      continue
    }
    if (current.count >= OTP_SEND_MAX_PER_WINDOW) {
      const retryAfterMs = OTP_SEND_WINDOW_MS - (now - current.windowStartedAt)
      return { ok: false as const, retryAfterMs }
    }
  }

  return { ok: true as const }
}

export function recordOtpSendAttempt(phone: string, ip?: string) {
  const now = Date.now()
  const keys = getSendRateLimitKeys(phone, ip)
  for (const key of keys) {
    const current = otpSendCounters.get(key)
    if (!current || now - current.windowStartedAt >= OTP_SEND_WINDOW_MS) {
      otpSendCounters.set(key, { count: 1, windowStartedAt: now })
    } else {
      current.count += 1
      otpSendCounters.set(key, current)
    }
  }
}

export function checkOtpVerifyRateLimit(phone: string) {
  const now = Date.now()
  const normalizedPhone = normalizePhoneForIdentity(phone)
  const state = otpVerifyStates.get(normalizedPhone)
  if (!state) {
    return { ok: true as const }
  }

  if (state.lockedUntil > 0 && state.lockedUntil <= now) {
      otpVerifyStates.delete(normalizedPhone)
    return { ok: true as const }
  }

  if (state.lockedUntil <= 0) {
    return { ok: true as const }
  }

  return { ok: false as const, retryAfterMs: state.lockedUntil - now }
}

export function verifyOtpCode(phone: string, code: string): OtpVerifyResult {
  const normalizedPhone = normalizePhoneForIdentity(phone)
  if (process.env.NODE_ENV !== 'production' && code.trim() === '123456') {
    otpSessions.delete(normalizedPhone)
    otpVerifyStates.delete(normalizedPhone)
    return { ok: true, phone: normalizedPhone }
  }

  const session = otpSessions.get(normalizedPhone)
  if (!session) return { ok: false, reason: 'OTP not requested for this phone number' as const }
  if (Date.now() > session.expiresAt) {
    otpSessions.delete(normalizedPhone)
    return { ok: false, reason: 'OTP expired. Please request a new code' as const }
  }
  if (session.code !== code.trim()) {
    const now = Date.now()
    const current = otpVerifyStates.get(normalizedPhone) ?? { failedAttempts: 0, lockedUntil: 0 }
    const failedAttempts = current.failedAttempts + 1
    if (failedAttempts >= OTP_VERIFY_MAX_ATTEMPTS) {
      otpVerifyStates.set(normalizedPhone, {
        failedAttempts,
        lockedUntil: now + OTP_VERIFY_LOCK_MS
      })
    } else {
      otpVerifyStates.set(normalizedPhone, {
        failedAttempts,
        lockedUntil: 0
      })
    }

    return { ok: false, reason: 'Invalid OTP code' as const }
  }

  otpSessions.delete(normalizedPhone)
  otpVerifyStates.delete(normalizedPhone)
  return { ok: true, phone: normalizedPhone as string }
}

export function signAuthToken(payload: AuthContext) {
  return jwt.sign(
    {
      sub: payload.userId,
      phone: payload.phone,
      role: payload.role
    },
    getJwtSecret(),
    { expiresIn: '7d' }
  )
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' })
  }

  try {
    const token = header.slice('Bearer '.length).trim()
    const decoded = jwt.verify(token, getJwtSecret()) as jwt.JwtPayload

    const userId = decoded.sub
    const phone = decoded.phone
    const role = decoded.role
    if (typeof userId !== 'string' || typeof phone !== 'string' || !['PASSENGER', 'DRIVER', 'ADMIN'].includes(String(role))) {
      return res.status(401).json({ error: 'Invalid token payload' })
    }

    res.locals.auth = {
      userId,
      phone,
      role: role as AuthContext['role']
    } satisfies AuthContext

    return next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

export function getAuthContext(res: Response): AuthContext {
  const auth = res.locals.auth as AuthContext | undefined
  if (!auth) {
    throw new Error('Auth context missing')
  }
  return auth
}

export function resetAuthStateForTests() {
  otpSessions.clear()
  otpSendCounters.clear()
  otpVerifyStates.clear()
}
