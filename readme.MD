# Eride Backend

TypeScript + Express backend for ride-hailing APIs, real-time ride updates (Socket.IO), and PostgreSQL data access via Prisma.

## Tech Stack
- Node.js + TypeScript (`strict` mode)
- Express 4
- Prisma ORM + PostgreSQL
- Socket.IO
- Zod for request validation

## Project Layout
- `src/index.ts` - server bootstrap
- `src/app.ts` - middleware and route registration
- `src/routes/` - feature routes (`auth`, `bookings`, `rides`, `payments`, etc.)
- `prisma/schema.prisma` - database schema
- `prisma/migrations/` - migration history
- `prisma/seed.ts` - seed script
- `dist/` - compiled output

## Setup
1. Install dependencies:
```bash
npm install
```
2. Create environment file:
```bash
cp .env.example .env
```
3. Update `.env` values:
- `DATABASE_URL`
- `PORT` (default `4000`)
- `GOOGLE_MAPS_API_KEY`

## Database Workflow
```bash
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

## Run Locally
Development (watch mode):
```bash
npm run dev
```

Build and run compiled app:
```bash
npm run build
npm start
```

Health check endpoint:
- `GET /health` -> `{ "ok": true }`

## Notes
- No automated test runner is configured yet; use `npm run build` plus manual API verification.
- Do not edit `dist/` directly; it is generated from `src/`.
