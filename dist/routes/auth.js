import { Router } from 'express';
import { z } from 'zod';
import prisma from '../db';
import { checkOtpSendRateLimit, checkOtpVerifyRateLimit, createOtp, signAuthToken, verifyOtpCode } from '../lib/auth';
const router = Router();
router.post('/otp/send', (req, res) => {
    const parsed = z.object({ phone: z.string().min(8).max(20) }).safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const limited = checkOtpSendRateLimit(parsed.data.phone, req.ip);
    if (!limited.ok) {
        const retryAfterSec = Math.max(1, Math.ceil(limited.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({ error: 'Too many OTP requests. Please try again later.', retryAfterSec });
    }
    const session = createOtp(parsed.data.phone);
    const isProd = process.env.NODE_ENV === 'production';
    return res.json({
        ok: true,
        message: 'OTP sent',
        ...(isProd ? {} : { debugCode: session.code, expiresAt: new Date(session.expiresAt).toISOString() })
    });
});
router.post('/otp/verify', async (req, res) => {
    const parsed = z.object({ phone: z.string().min(8).max(20), code: z.string().length(6) }).safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const verifyLimited = checkOtpVerifyRateLimit(parsed.data.phone);
    if (!verifyLimited.ok) {
        const retryAfterSec = Math.max(1, Math.ceil(verifyLimited.retryAfterMs / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({ error: 'Too many OTP verification attempts. Please try again later.', retryAfterSec });
    }
    const otpResult = verifyOtpCode(parsed.data.phone, parsed.data.code);
    if (!otpResult.ok) {
        return res.status(401).json({ error: otpResult.reason });
    }
    const user = await prisma.user.upsert({
        where: { phone: otpResult.phone },
        update: {},
        create: {
            phone: otpResult.phone,
            name: `User ${otpResult.phone.slice(-4)}`,
            role: 'PASSENGER'
        }
    });
    const token = signAuthToken({
        userId: user.id,
        phone: user.phone,
        role: user.role
    });
    return res.json({ ok: true, token });
});
router.post('/register', async (req, res) => {
    const parsed = z.object({
        name: z.string().min(2).max(80),
        phone: z.string().min(8).max(20),
        email: z.string().email().optional()
    }).safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ error: parsed.error.flatten() });
    }
    const user = await prisma.user.upsert({
        where: { phone: parsed.data.phone },
        update: {
            name: parsed.data.name,
            email: parsed.data.email
        },
        create: {
            name: parsed.data.name,
            phone: parsed.data.phone,
            email: parsed.data.email,
            role: 'PASSENGER'
        }
    });
    return res.json({ ok: true, userId: user.id });
});
export default router;
