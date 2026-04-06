import { Router } from 'express'
import prisma from '../db'

const router = Router()

// Stub: returns a seeded user based on X-Dev-Role header (DRIVER or PASSENGER).
// Replace with real JWT-based lookup when proper auth is implemented.
router.get('/me', async (req, res) => {
  const devRole = (req.headers['x-dev-role'] as string)?.toUpperCase()
  const role = devRole === 'DRIVER' ? 'DRIVER' : 'PASSENGER'
  const user = await prisma.user.findFirst({ where: { role } })
  if (!user) return res.status(404).json({ error: `No ${role} user found — run npm run prisma:seed` })
  res.json({ id: user.id, name: user.name, role: user.role })
})

router.put('/me', (_req, res) => {
  res.json({ ok: true })
})

router.get('/me/saved-places', (_req, res) => {
  res.json({ items: [] })
})

router.post('/me/saved-places', (_req, res) => {
  res.json({ ok: true })
})

export default router
