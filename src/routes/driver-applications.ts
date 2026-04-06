import { Router } from 'express'
import { z } from 'zod'
import prisma from '../db'

const router = Router()

const createSchema = z.object({
  userId: z.string(),
  fullName: z.string().min(1),
  phone: z.string().min(6),
  email: z.string().email().optional(),
  address: z.string().min(3)
})

const updateSchema = z.object({
  fullName: z.string().min(1).optional(),
  phone: z.string().min(6).optional(),
  email: z.string().email().optional(),
  address: z.string().min(3).optional(),
  experienceYears: z.number().int().min(0).optional(),
  preferredArea: z.string().optional()
})

const availabilitySchema = z.object({
  days: z.string(),
  hours: z.string(),
  preferredCity: z.string()
})

const documentSchema = z.object({
  type: z.string(),
  fileUrl: z.string().url()
})

router.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const application = await prisma.driverApplication.upsert({
    where: { userId: parsed.data.userId },
    update: { ...parsed.data },
    create: { ...parsed.data }
  })

  res.json({ ok: true, application })
})

router.get('/:id', async (req, res) => {
  const application = await prisma.driverApplication.findUnique({
    where: { id: req.params.id },
    include: { documents: true, availability: true }
  })
  if (!application) return res.status(404).json({ error: 'Not found' })
  res.json(application)
})

router.put('/:id', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const application = await prisma.driverApplication.update({
    where: { id: req.params.id },
    data: parsed.data
  })

  res.json({ ok: true, application })
})

router.post('/:id/documents', async (req, res) => {
  const parsed = documentSchema.safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const doc = await prisma.driverDocument.create({
    data: {
      applicationId: req.params.id,
      type: parsed.data.type,
      fileUrl: parsed.data.fileUrl
    }
  })

  res.json({ ok: true, document: doc })
})

router.post('/:id/availability', async (req, res) => {
  const parsed = availabilitySchema.safeParse(req.body)
  if (!parsed.success) return res.status(422).json({ error: parsed.error.flatten() })

  const availability = await prisma.driverAvailability.upsert({
    where: { applicationId: req.params.id },
    update: parsed.data,
    create: { applicationId: req.params.id, ...parsed.data }
  })

  res.json({ ok: true, availability })
})

router.post('/:id/submit', async (req, res) => {
  const application = await prisma.driverApplication.update({
    where: { id: req.params.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() }
  })

  res.json({ ok: true, application })
})

export default router
