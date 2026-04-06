import { Router } from 'express'

const router = Router()

router.post('/otp/send', (_req, res) => {
  res.json({ ok: true, message: 'OTP sent' })
})

router.post('/otp/verify', (_req, res) => {
  res.json({ ok: true, token: 'dev-token' })
})

router.post('/register', (_req, res) => {
  res.json({ ok: true, userId: 'dev-user' })
})

export default router
