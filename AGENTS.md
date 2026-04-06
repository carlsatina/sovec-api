# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains application code.
- `src/index.ts` boots the HTTP server and Socket.IO.
- `src/app.ts` wires middleware and route modules.
- `src/routes/*.ts` contains feature routes (`auth`, `bookings`, `rides`, `drivers`, etc.).
- `src/db.ts` exports the shared Prisma client.
- `prisma/schema.prisma` defines data models and enums; `prisma/migrations/` stores migration history; `prisma/seed.ts` seeds local data.
- `dist/` is compiled output from TypeScript (`tsc`) and should not be edited manually.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: run the API in watch mode using `tsx`.
- `npm run build`: compile TypeScript from `src/` to `dist/`.
- `npm start`: run compiled server from `dist/index.js`.
- `npm run prisma:generate`: regenerate Prisma client after schema changes.
- `npm run prisma:migrate`: create/apply local Prisma migrations.
- `npm run prisma:seed`: seed the database via `prisma/seed.ts`.

## Coding Style & Naming Conventions
- Language: TypeScript (`strict` mode enabled in `tsconfig.json`).
- Indentation: 2 spaces; keep imports grouped at file top.
- Files in `src/routes/` use kebab-case (example: `driver-applications.ts`).
- Use `camelCase` for variables/functions and `PascalCase` for types/interfaces.
- Keep request validation near handlers using `zod` schemas.
- Prefer small route modules with explicit HTTP paths (example: `router.post('/estimate', ...)`).

## Testing Guidelines
- There is currently no automated test framework configured in `package.json`.
- For now, validate changes with:
  - `npm run build` (type/compile check)
  - manual endpoint checks (for example via Postman/curl)
- When adding tests, place them alongside feature modules or under a top-level `tests/` directory and use `*.test.ts` naming.

## Commit & Pull Request Guidelines
- Git history is currently minimal (`Initial commit backend`), so no strict convention is enforced yet.
- Use clear, imperative commit subjects (example: `Add booking cancellation guard`).
- Keep commits focused by concern (routes, schema, or infra changes).
- PRs should include:
  - concise summary of behavior changes
  - migration notes for `prisma/schema.prisma` updates
  - local verification steps and results (`npm run build`, API checks)
  - linked issue/task when applicable

## Security & Configuration Tips
- Copy `.env.example` to `.env` and set `DATABASE_URL`, `PORT`, and `GOOGLE_MAPS_API_KEY`.
- Never commit secrets or real API keys.
- Review schema and route changes together when handling payments, auth, or role logic.
