import { Router } from 'express';
import { z } from 'zod';
import prisma from '../db';
const router = Router();
const locationSchema = z.object({
    driverId: z.string(),
    lat: z.number(),
    lng: z.number(),
    isAvailable: z.boolean().optional()
});
router.post('/location', async (req, res) => {
    const parsed = locationSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const { driverId, lat, lng, isAvailable } = parsed.data;
    const location = await prisma.driverLocation.upsert({
        where: { driverId },
        update: { lat, lng, isAvailable: isAvailable ?? true },
        create: { driverId, lat, lng, isAvailable: isAvailable ?? true }
    });
    return res.json({ ok: true, location });
});
router.post('/:id/availability', async (req, res) => {
    const driverId = req.params.id;
    const parsed = z.object({ isAvailable: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const location = await prisma.driverLocation.update({
        where: { driverId },
        data: { isAvailable: parsed.data.isAvailable }
    });
    return res.json({ ok: true, location });
});
export default router;
