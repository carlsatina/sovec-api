import { Router } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { getIo } from '../socket';
const router = Router();
router.get('/:id', async (req, res) => {
    const ride = await prisma.ride.findUnique({ where: { id: req.params.id } });
    if (!ride)
        return res.status(404).json({ error: 'Ride not found' });
    res.json(ride);
});
router.post('/:id/status', async (req, res) => {
    const parsed = z.object({ status: z.string() }).safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const ride = await prisma.ride.update({
        where: { id: req.params.id },
        data: {
            status: parsed.data.status,
            events: { create: [{ type: parsed.data.status }] }
        }
    });
    if ((parsed.data.status === 'COMPLETED' || parsed.data.status === 'CANCELLED') && ride.driverId) {
        await prisma.driverLocation.update({
            where: { driverId: ride.driverId },
            data: { isAvailable: true }
        });
    }
    const io = getIo();
    io.to(`ride:${ride.id}`).emit('ride:status', { rideId: ride.id, status: ride.status });
    res.json({ id: ride.id, status: ride.status });
});
router.post('/:id/events', async (req, res) => {
    const parsed = z.object({ type: z.string(), metadata: z.any().optional() }).safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const event = await prisma.rideEvent.create({
        data: {
            rideId: req.params.id,
            type: parsed.data.type,
            metadata: parsed.data.metadata
        }
    });
    res.json({ id: event.id, event: event.type });
});
router.get('/', async (_req, res) => {
    const items = await prisma.ride.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
    res.json({ items });
});
export default router;
