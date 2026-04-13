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
- `EMAIL_PROVIDER` (`stub` or `resend`)
- If using Resend:
  - `RESEND_API_KEY`
  - `RESEND_FROM_EMAIL` (must be a verified sender/domain in Resend)
- Payment settings:
  - `PAYMENT_PROVIDER` (`mock` or `paymongo`)
  - `PAYMENT_WEBHOOK_SECRET` (used by `mock` webhook auth)
  - If using PayMongo:
    - `PAYMONGO_SECRET_KEY`
    - `PAYMONGO_WEBHOOK_SECRET` (for webhook signature verification)
    - `PAYMONGO_SUCCESS_URL`
    - `PAYMONGO_CANCEL_URL`
    - `PAYMONGO_API_BASE` (default `https://api.paymongo.com`)
    - `PAYMONGO_CHECKOUT_API_VERSION` (default `v1`)
- Safety escalation channels (optional):
  - `SAFETY_ESCALATION_PHONES` (comma-separated phone numbers for SMS alerts)
  - `SAFETY_ESCALATION_EMAILS` (comma-separated email recipients)
  - `SAFETY_ESCALATION_WEBHOOK_URL` (POST webhook endpoint for escalation/resolution events)
  - `SAFETY_DELIVERY_MAX_ATTEMPTS` (default `3`)
  - `SAFETY_DELIVERY_RETRY_DELAY_MS` (default `250`)

## Database Workflow
```bash
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
```

Seeded admin user for local testing:
- Phone: `+639179999999`
- Role: `ADMIN`

## Admin Bootstrap (Hardened)
Use this when you need to promote a real account to `ADMIN` without relying on seed data.

Command:
```bash
BOOTSTRAP_PHONE=+639171111111 \
ADMIN_BOOTSTRAP_SECRET=<server-secret> \
BOOTSTRAP_SECRET=<same-secret> \
npm run admin:bootstrap
```

Behavior:
- Promotes an existing `PASSENGER` or `DRIVER` user to `ADMIN`
- Idempotent for existing admin user (returns success with `mode=already_admin`)
- One-time guard: blocked if any `ADMIN` already exists
  - Override only when needed:
  - `ALLOW_ADMIN_BOOTSTRAP_WHEN_ADMIN_EXISTS=true`
- Refuses insecure mode unless explicitly allowed:
  - `ALLOW_INSECURE_ADMIN_BOOTSTRAP=true` (local/dev only)

Required env for secure mode:
- `ADMIN_BOOTSTRAP_SECRET` (server-side configured secret)
- `BOOTSTRAP_SECRET` (operator-provided secret for the command)

How to get an `ADMIN_TOKEN` after bootstrap:
1. `POST /auth/otp/send` using the promoted admin phone
2. `POST /auth/otp/verify` with OTP code
3. Use returned JWT as `ADMIN_TOKEN`

Token rotation:
- Rotate `JWT_SECRET` to invalidate existing tokens globally.
- Recommended process: deploy new `JWT_SECRET`, then re-login admins to obtain new tokens.

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
SMOKE_PHONE=+639171111111 npm run smoke
```

Notes:
- For `SMS_PROVIDER=mock`, the script auto-uses `debugCode`.
- For real SMS providers, pass the received OTP:
```bash
SMOKE_PHONE=+639171111111 SMOKE_OTP_CODE=123456 npm run smoke
```
- Optional: `API_URL=http://localhost:4000` (defaults to this value).

Health check endpoint:
- `GET /health` -> `{ "ok": true }`

## Notes
- Automated tests are available via `npm test`.
- OTP SMS delivery uses `SMS_PROVIDER=mock` locally and should be set to `semaphore` in production.
- Do not edit `dist/` directly; it is generated from `src/`.

## Payments API (Phase 4 Foundation)
- `GET /payments/methods`
  - Returns supported methods (`CASH`, `EWALLET`, `CARD`)
- `POST /payments/charge` (authenticated)
  - Body: `{ rideId, method?, amount? }`
  - Validates rider ownership of ride, upserts payment row, calls provider adapter, persists status/reference
  - Provider behavior:
    - `mock`:
      - `CASH` -> immediate `PAID`
      - `EWALLET` / `CARD` -> `PENDING` + mock `checkoutUrl`
    - `paymongo`:
      - `CASH` -> immediate `PAID` (manual/offline settlement path)
      - `EWALLET` / `CARD` -> creates PayMongo Checkout Session, returns hosted `checkoutUrl`
- `POST /payments/webhooks/:provider`
  - Supported providers: `mock`, `paymongo`
  - `mock` header (when `PAYMENT_WEBHOOK_SECRET` is configured): `x-payment-webhook-secret`
  - `paymongo` header: `paymongo-signature` (validated when `PAYMONGO_WEBHOOK_SECRET` is configured)
  - Body (mock): `{ eventId, reference, status }`
  - Applies payment status transition and records a ride event (`PAYMENT_WEBHOOK_STATUS_CHANGED`)

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
- `GET /admin/payments`
  - Query params:
    - `status`: `PENDING | PAID | VERIFIED | FAILED | REFUND_PENDING | REFUNDED`
    - `method`: `CASH | EWALLET | CARD`
    - `q`: search on payment/ride/ref/rider/driver fields
    - `page`: default `1`
    - `limit`: default `20`, max `100`
- `POST /admin/payments/:id/verify`
  - Body: `{ note? }`
  - Sets payment status to `VERIFIED` and logs an admin payment event
- `POST /admin/payments/:id/fail`
  - Body: `{ reason? }`
  - Sets payment status to `FAILED` and logs an admin payment event
- `POST /admin/payments/:id/refund`
  - Body: `{ reason, amount? }`
  - Creates manual refund record by moving status to `REFUND_PENDING` and logging admin refund request event
- `GET /admin/pricing`
  - Returns the current fare configuration singleton
- `PUT /admin/pricing`
  - Body: `{ baseFare, perKmRate, perMinuteRate, minimumFare, currency? }`
  - Validation:
    - all rates must be non-negative
    - `minimumFare >= baseFare`
- `GET /admin/vehicles`
  - Query params:
    - `status`: `AVAILABLE | IN_USE | CHARGING | MAINTENANCE`
    - `q`: search on plate/model/color/driver name/phone
    - `page`: default `1`
    - `limit`: default `20`, max `100`
- `POST /admin/vehicles`
  - Body: `{ plateNumber, model, capacity, color?, status?, batteryCapacityKwh?, batteryLevel?, driverId? }`
- `POST /admin/vehicles/:id/assign-driver`
  - Body: `{ driverId? }`
  - Use `null`/empty to unassign vehicle driver
- `GET /admin/vehicles/:id/history`
  - Query params:
    - `action`: `FLEET_CREATE_VEHICLE | FLEET_ASSIGN_DRIVER | FLEET_UPDATE_STATUS` (optional)
    - `page`: default `1`
    - `limit`: default `20`, max `100`
  - Returns fleet action history from admin audit logs for one vehicle
- `POST /admin/vehicles/:id/status`
  - Body: `{ status, batteryLevel? }`
  - Transition rules:
    - `IN_USE -> AVAILABLE` only
    - `CHARGING -> AVAILABLE` only
    - `MAINTENANCE -> AVAILABLE` only
    - `AVAILABLE -> AVAILABLE | IN_USE | CHARGING | MAINTENANCE`
  - Validation rules:
    - `IN_USE` requires assigned driver and battery `>= 15%`
    - `AVAILABLE` rejects battery `< 10%`
    - `CHARGING` requires explicit battery value `< 100%`
- `GET /admin/support/tickets`
  - Query params:
    - `status`: `OPEN | IN_REVIEW | RESOLVED | CLOSED`
    - `category`: text filter
    - `q`: search on id/category/description/user fields
    - `page`: default `1`
    - `limit`: default `20`, max `100`
- `POST /admin/support/tickets/:id/status`
  - Body: `{ status, note? }`
  - Sends a support update notification to the ticket owner
- `GET /admin/safety/incidents`
  - Query params:
    - `status`: `OPEN | IN_REVIEW | RESOLVED | CLOSED`
    - `priority`: `LOW | MEDIUM | HIGH | CRITICAL`
    - `assigneeId`: admin user id
    - `overdue`: `true | false`
    - `q`: text filter
    - `activeOnly`: default `true` (returns `OPEN` + `IN_REVIEW` when no status provided)
    - `page`: default `1`
    - `limit`: default `20`, max `100`
  - Response includes enriched fields:
    - `incidentMeta` (priority, assignee, acknowledge/resolve timestamps, parsed note)
    - `timeline` (safety lifecycle events)
    - `sla` (ack/resolve durations + overdue flag)
- `GET /admin/safety/templates`
  - Returns notification templates used for safety escalation/resolution channel messages
  - Templates are persisted in DB table `SafetyTemplate` (not runtime memory)
- `PUT /admin/safety/templates/:key`
  - Keys: `ESCALATION_ADMIN | ESCALATION_REPORTER | RESOLUTION_REPORTER`
  - Body: `{ subject?, body? }`
- `POST /admin/safety/incidents/:id/resolve`
  - Body: `{ status: RESOLVED|CLOSED, action, note? }`
  - Updates incident status, app notification, and escalation-channel fan-out (SMS/email/webhook)
  - Delivery uses retry policy and writes delivery/dead-letter logs into `SafetyDeliveryLog`
- `POST /admin/safety/incidents/:id/acknowledge`
  - Body: `{ note? }`
  - Marks incident `IN_REVIEW` and records acknowledgement metadata
- `POST /admin/safety/incidents/:id/assign`
  - Body: `{ assigneeId?, note? }`
  - Assigns incident to an admin (defaults to current admin)
- `POST /admin/safety/incidents/:id/escalate`
  - Body: `{ priority: LOW|MEDIUM|HIGH|CRITICAL, reason }`
  - Updates incident priority, records escalation metadata, and triggers channel fan-out
- `GET /admin/safety/delivery-logs`
  - Query params:
    - `incidentId` (optional)
    - `status`: `DELIVERED | DEAD_LETTER` (optional)
    - `channel`: `sms | email | webhook` (optional)
    - `q`: search on id/incident/target/error
    - `page`, `limit`
- `POST /admin/safety/delivery-logs/:id/retry`
  - Retries a dead-lettered safety delivery log entry
  - Fails fast for unsupported `event` / `channel` log rows
- `GET /admin/analytics/overview`
  - Returns:
    - `today`: rides, completed/cancelled rides, revenue
    - `activeDrivers`: currently available drivers
    - `rolling30d`: rides, revenue, completion/cancellation rates
- `GET /admin/analytics/trends`
  - Query params:
    - `days`: integer `1..90` (default `7`)
  - Returns daily buckets with `rides`, `completedRides`, `cancelledRides`, `revenue`
- `GET /admin/audit-logs`
  - Query params:
    - `actorId` (admin user id)
    - `action` (exact action code)
    - `targetType` (exact target type)
    - `q` search on id/summary/action/target/admin
    - `page`, `limit`
  - Returns admin audit trail entries with actor info

Fare computation (`/bookings/estimate` and booking creation) now uses the persisted admin pricing config.

SOS API:
- `POST /rides/:id/sos` (authenticated rider/driver only)
  - Body: `{ severity: LOW|MEDIUM|HIGH|CRITICAL, note? }`
  - Creates a safety incident ticket and `SOS_TRIGGERED` ride event

## Smoke Tests
- Single command:
  - `npm run smoke`
- Default auto-selection:
  - Runs `auth` when `SMOKE_PHONE` is set
  - Runs admin suites (`admin-fleet`, `admin-support`, `admin-analytics`, `admin-safety`) when `ADMIN_TOKEN` is set
  - `admin-bootstrap` is opt-in only (never auto-selected)
- Explicit suite selection:
  - `SMOKE_SUITES=auth npm run smoke`
  - `SMOKE_SUITES=payments SMOKE_PHONE=+639171111111 npm run smoke`
  - `SMOKE_SUITES=admin-bootstrap BOOTSTRAP_PHONE=+639171111111 ADMIN_BOOTSTRAP_SECRET=<secret> BOOTSTRAP_SECRET=<secret> npm run smoke`
  - `SMOKE_SUITES=admin-fleet,admin-support npm run smoke`
  - `SMOKE_SUITES=admin-analytics SMOKE_ANALYTICS_DAYS=30 npm run smoke`
  - `SMOKE_SUITES=admin-safety ADMIN_TOKEN=<admin-jwt> npm run smoke`
- Suite-specific env vars:
  - Auth: `SMOKE_PHONE`, optional `SMOKE_OTP_CODE`
  - Payments: `SMOKE_PHONE`, optional `SMOKE_OTP_CODE`, optional `PAYMENT_WEBHOOK_SECRET` (mock), `PAYMENT_PROVIDER` (mock/paymongo)
  - Admin bootstrap: `BOOTSTRAP_PHONE`, `ADMIN_BOOTSTRAP_SECRET`, `BOOTSTRAP_SECRET` (or `ALLOW_INSECURE_ADMIN_BOOTSTRAP=true`), optional `SMOKE_OTP_CODE`
  - Admin fleet: `ADMIN_TOKEN`, optional `SMOKE_DRIVER_ID` (enables assignment + `IN_USE` transition checks)
  - Admin support: `ADMIN_TOKEN`, optional `SMOKE_SUPPORT_TICKET_ID`, optional `SMOKE_SUPPORT_CATEGORY`
  - Admin analytics: `ADMIN_TOKEN`, optional `SMOKE_ANALYTICS_DAYS`
  - Admin safety: `ADMIN_TOKEN`, optional `SMOKE_SAFETY_INCIDENT_ID`, optional `SMOKE_RETRY_DEAD_LETTER=true`
