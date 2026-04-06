import { Router } from 'express'

const router = Router()

router.get('/wallet', (_req, res) => {
  res.json({ points: 1240, balance: 0 })
})

router.post('/redeem', (_req, res) => {
  res.json({ ok: true })
})

export default router
