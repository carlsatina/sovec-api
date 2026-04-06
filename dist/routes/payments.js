import { Router } from 'express';
const router = Router();
router.get('/methods', (_req, res) => {
    res.json({ methods: ['CASH', 'EWALLET', 'CARD'] });
});
router.post('/charge', (_req, res) => {
    res.json({ ok: true, paymentId: 'pay_123' });
});
router.get('/receipts/:rideId', (req, res) => {
    res.json({ rideId: req.params.rideId, receiptUrl: null });
});
export default router;
