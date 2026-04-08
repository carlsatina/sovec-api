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
- `JWT_SECRET` (required in production)
- `GOOGLE_MAPS_API_KEY`
- `SMS_PROVIDER` (`mock` or `semaphore`)
- If using Semaphore:
  - `SEMAPHORE_API_KEY`
  - `SEMAPHORE_SENDER_NAME` (optional)
  - `SEMAPHORE_OTP_MESSAGE` (optional, supports `{otp}` placeholder)

## Database Workflow
```bash
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

Seeded admin user for local testing:
- Phone: `+639179999999`
- Role: `ADMIN`

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

## API Smoke Test
Use this to validate the auth flow end-to-end:
- `POST /auth/otp/send`
- `POST /auth/otp/verify`
- `GET /users/me`
- `GET /users/me/rides`

Run:
```bash
SMOKE_PHONE=+639171111111 npm run smoke:auth
```

Notes:
- For `SMS_PROVIDER=mock`, the script auto-uses `debugCode`.
- For real SMS providers, pass the received OTP:
```bash
SMOKE_PHONE=+639171111111 SMOKE_OTP_CODE=123456 npm run smoke:auth
```
- Optional: `API_URL=http://localhost:4000` (defaults to this value).

Health check endpoint:
- `GET /health` -> `{ "ok": true }`

## Notes
- Automated tests are available via `npm test`.
- OTP SMS delivery uses `SMS_PROVIDER=mock` locally and should be set to `semaphore` in production.
- Do not edit `dist/` directly; it is generated from `src/`.

## Admin APIs (Current)
- `GET /admin/driver-applications`
  - Query params:
    - `status`: `DRAFT | SUBMITTED | UNDER_REVIEW | INTERVIEW | APPROVED | REJECTED`
    - `q`: search on applicant/user name, phone, email
    - `page`: default `1`
    - `limit`: default `20`, max `100`
  - Response includes pagination: `page`, `limit`, `total`, `totalPages`
- `POST /admin/driver-applications/:id/status`
  - Body: `{ status, reason? }`
  - `reason` is required when `status=REJECTED`
  - Enforces status transition rules
- `POST /admin/driver-applications/:id/interview`
  - Body: `{ interviewAt: ISO8601 }`
  - Enforces status transition rules
- `GET /admin/rides`
  - Query params:
    - `status`: `REQUESTED | FINDING_DRIVER | ASSIGNED | ARRIVING | IN_PROGRESS | COMPLETED | CANCELLED`
    - `q`: search on ride id, addresses, rider/driver name/phone
    - `activeOnly`: default `true`
    - `page`: default `1`
    - `limit`: default `20`, max `100`
  - Response includes pagination: `page`, `limit`, `total`, `totalPages`
- `POST /admin/rides/:id/force-cancel`
  - Body: `{ reason? }`
  - Cancels active ride and emits live ride status update
- `POST /admin/rides/:id/reassign`
  - Body: `{ reason?, preferredDriverId? }`
  - Reassigns active ride; can target a preferred available driver
- `GET /admin/pricing`
  - Returns the current fare configuration singleton
- `PUT /admin/pricing`
  - Body: `{ baseFare, perKmRate, perMinuteRate, minimumFare, currency? }`
  - Validation:
    - all rates must be non-negative
    - `minimumFare >= baseFare`

Fare computation (`/bookings/estimate` and booking creation) now uses the persisted admin pricing config.
