import { Router } from 'express';
const router = Router();
router.get('/me', (_req, res) => {
    res.json({ id: 'dev-user', name: 'Demo User' });
});
router.put('/me', (_req, res) => {
    res.json({ ok: true });
});
router.get('/me/saved-places', (_req, res) => {
    res.json({ items: [] });
});
router.post('/me/saved-places', (_req, res) => {
    res.json({ ok: true });
});
export default router;
