import { Router } from 'express'

const router = Router()

router.get('/', (_req, res) => {
  res.json({ items: [] })
})

router.post('/apply', (_req, res) => {
  res.json({ ok: true, discount: 50 })
})

export default router
