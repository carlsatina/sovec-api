import { Router } from 'express';
const router = Router();
router.get('/faqs', (_req, res) => {
    res.json({ items: [] });
});
router.post('/tickets', (_req, res) => {
    res.json({ ok: true, ticketId: 'ticket_123' });
});
export default router;
