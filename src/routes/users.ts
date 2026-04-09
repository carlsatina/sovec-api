import { Router } from 'express'
import prisma from '../db.js'
import { getAuthContext, requireAuth } from '../lib/auth.js'

const router = Router()

router.get('/me', requireAuth, async (_req, res) => {
  const auth = getAuthContext(res)
  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, name: true, role: true }
  })
  if (!user) return res.status(404).json({ error: 'User not found' })
  return res.json(user)
})

router.get('/me/rides', requireAuth, async (req, res) => {
  const auth = getAuthContext(res)
  const parsedLimit = Number(req.query.limit ?? 20)
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, Math.floor(parsedLimit))) : 20

  const where = auth.role === 'DRIVER' ? { driverId: auth.userId } : { riderId: auth.userId }

  const items = await prisma.ride.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      rider: { select: { id: true, name: true, phone: true } },
      driver: { select: { id: true, name: true, phone: true } }
    }
  })

  return res.json({ items })
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
