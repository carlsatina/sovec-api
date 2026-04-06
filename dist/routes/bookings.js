import { Router } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { getIo } from '../socket';
const router = Router();
const fareEstimateSchema = z.object({
    pickupLat: z.number(),
    pickupLng: z.number(),
    dropoffLat: z.number(),
    dropoffLng: z.number()
});
router.post('/estimate', (req, res) => {
    const parsed = fareEstimateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const { pickupLat, pickupLng, dropoffLat, dropoffLng } = parsed.data;
    const distanceKm = haversine(pickupLat, pickupLng, dropoffLat, dropoffLng);
    const durationMin = Math.max(4, (distanceKm / 22) * 60);
    const breakdown = {
        base: 55,
        distance: Math.round(distanceKm * 15),
        time: Math.round(durationMin * 2.8)
    };
    res.json({
        currency: 'PHP',
        total: breakdown.base + breakdown.distance + breakdown.time,
        distanceKm: Number(distanceKm.toFixed(2)),
        durationMin: Math.round(durationMin),
        breakdown
    });
});
const createBookingSchema = z.object({
    riderId: z.string().optional(),
    pickupAddress: z.string(),
    pickupLat: z.number(),
    pickupLng: z.number(),
    dropoffAddress: z.string(),
    dropoffLat: z.number(),
    dropoffLng: z.number(),
    paymentMethod: z.enum(['CASH', 'EWALLET', 'CARD'])
});
function haversine(lat1, lon1, lat2, lon2) {
    const toRad = (v) => (v * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
async function findNearestDriver(lat, lng) {
    const locations = await prisma.driverLocation.findMany({
        where: { isAvailable: true },
        include: { driver: true }
    });
    if (!locations.length)
        return null;
    const scored = locations.map((loc) => ({
        driverId: loc.driverId,
        distance: haversine(lat, lng, loc.lat, loc.lng)
    }));
    scored.sort((a, b) => a.distance - b.distance);
    return scored[0].driverId;
}
router.post('/', async (req, res) => {
    const parsed = createBookingSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const data = parsed.data;
    const riderId = data.riderId
        ? data.riderId
        : (await prisma.user.findFirst({ where: { role: 'PASSENGER' } }))?.id;
    if (!riderId) {
        return res.status(404).json({ error: 'No rider found' });
    }
    const ride = await prisma.ride.create({
        data: {
            riderId,
            status: 'FINDING_DRIVER',
            pickupAddress: data.pickupAddress,
            pickupLat: data.pickupLat,
            pickupLng: data.pickupLng,
            dropoffAddress: data.dropoffAddress,
            dropoffLat: data.dropoffLat,
            dropoffLng: data.dropoffLng,
            fareAmount: 286,
            currency: 'PHP',
            paymentMethod: data.paymentMethod,
            events: {
                create: [{ type: 'FINDING_DRIVER' }]
            }
        }
    });
    const io = getIo();
    io.to(`ride:${ride.id}`).emit('ride:status', { rideId: ride.id, status: ride.status });
    io.to(`user:${riderId}`).emit('ride:status', { rideId: ride.id, status: ride.status });
    const driverId = await findNearestDriver(data.pickupLat, data.pickupLng);
    if (driverId) {
        const assigned = await prisma.ride.update({
            where: { id: ride.id },
            data: {
                driverId,
                status: 'ASSIGNED',
                events: { create: [{ type: 'ASSIGNED' }] }
            }
        });
        await prisma.driverLocation.update({
            where: { driverId },
            data: { isAvailable: false }
        });
        io.to(`ride:${ride.id}`).emit('ride:status', { rideId: ride.id, status: assigned.status, driverId });
        io.to(`user:${riderId}`).emit('ride:status', { rideId: ride.id, status: assigned.status, driverId });
        io.to(`user:${driverId}`).emit('ride:status', { rideId: ride.id, status: assigned.status, riderId });
    }
    res.json({ ok: true, rideId: ride.id, status: ride.status });
});
router.post('/:id/cancel', async (req, res) => {
    const id = req.params.id;
    const ride = await prisma.ride.update({
        where: { id },
        data: {
            status: 'CANCELLED',
            events: { create: [{ type: 'CANCELLED' }] }
        }
    });
    const io = getIo();
    io.to(`ride:${ride.id}`).emit('ride:status', { rideId: ride.id, status: ride.status });
    res.json({ ok: true, status: ride.status });
});
export default router;
