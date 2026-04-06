import { Router } from 'express';
import { z } from 'zod';
import prisma from '../db';
const router = Router();
router.get('/driver-applications', async (_req, res) => {
    const items = await prisma.driverApplication.findMany({
        orderBy: { updatedAt: 'desc' },
        include: { user: true, documents: true, availability: true }
    });
    res.json({ items });
});
router.post('/driver-applications/:id/status', async (req, res) => {
    const parsed = z.object({ status: z.enum(['UNDER_REVIEW', 'INTERVIEW', 'APPROVED', 'REJECTED']) }).safeParse(req.body);
    if (!parsed.success)
        return res.status(422).json({ error: parsed.error.flatten() });
    const application = await prisma.driverApplication.update({
        where: { id: req.params.id },
        data: { status: parsed.data.status }
    });
    res.json({ ok: true, application });
});
router.post('/driver-applications/:id/interview', async (req, res) => {
    const parsed = z.object({ interviewAt: z.string().datetime() }).safeParse(req.body);
    if (!parsed.success)
        return res.status(422).json({ error: parsed.error.flatten() });
    const application = await prisma.driverApplication.update({
        where: { id: req.params.id },
        data: { interviewAt: new Date(parsed.data.interviewAt), status: 'INTERVIEW' }
    });
    res.json({ ok: true, application });
});
export default router;
