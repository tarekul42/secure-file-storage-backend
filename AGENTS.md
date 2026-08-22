# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

Secure File Storage — a full-stack app for authenticated file uploads/downloads with
public/private sharing, storage quotas, and presigned S3 uploads.

- `backend/` — Node.js + Express 5 API (TypeScript, ESM), Prisma 7 ORM (PostgreSQL),
  AWS S3 via presigned URLs (single-PUT ≤ 100 MB, multipart up to 5 GB),
  JWT access tokens (15 min) + opaque refresh tokens (30 d, hashed, rotating).
- `frontend/` — Next.js (App Router) + axios client.
- `docker-compose.yml` — local Postgres (:5434) and MinIO (:9000/:9001) with bucket init.

Read `UPGRADE_PLAN.md` before doing any non-trivial work: it tracks exactly what has
been implemented (✅) and what remains (pending). Keep its status lines updated when
you complete an item.

## Commands

All backend commands run from `backend/`:

```bash
npm run dev            # dev server (tsx watch)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run format         # prettier --write
npm run format:check
npm test               # vitest run (requires docker compose up -d; Postgres on :5434)
npm run reconcile      # orphaned-S3-object sweep job (dry-run by default; --apply to act)

npx prisma migrate dev          # create/apply migrations locally
npx prisma validate
```

Frontend commands run from `frontend/`: `npm run dev`, `npm run build`, `npm run lint`.

Before finishing any task run, from `backend/`: `typecheck`, `lint`, `format:check`,
and `test` (tests need the compose stack up: `docker compose up -d` from the repo root).
All four must pass.

## Architecture & conventions

Backend follows a strict per-feature module layout — follow it:

```
src/modules/<feature>/
├── <feature>.routes.ts       # route definitions only
├── <feature>.controller.ts   # HTTP layer: parse req, call service, send res
├── <feature>.service.ts      # business logic, Prisma + S3 calls
├── <feature>.validation.ts   # zod schemas
├── <feature>.interfaces.ts   # types
└── <feature>.constants.ts    # feature constants
```

- Cross-cutting middleware lives in `src/middleware/` (auth, error handling,
  request-id, zod `validate` for body/query/params).
- Errors: throw `ApiError` subclasses from `src/utils/errors.ts`; the central error
  middleware formats responses. Never send errors ad hoc from controllers.
- Async route handlers must be wrapped with `asyncHandler`.
- Logging: use `logger` from `src/utils/logger.ts` (pino). Do not use
  `console.log`/`console.error`. Request correlation id comes from the request-id
  middleware.
- Validation: every external input goes through a zod schema via `validate()` —
  never trust raw `req.body/query/params`.
- Authz: files are owner-namespaced in S3 (`<ownerId>/<uuid>-<name>`); ownership is
  checked in the service layer against `req.user.id` from the auth middleware.
- Quota writes use atomic conditional updates inside transactions (see file service
  `registerFile`) — preserve this pattern to avoid TOCTOU races.
- Delete ordering: DB row first, then best-effort S3 delete. Never reverse this.
- S3 test mocks live per-test-file via `vi.mock` of `../src/db/s3.js`.

### Database

- Schema changes require a new additive migration (`prisma migrate dev --name ...`);
  never edit existing migrations.
- The generated Prisma client is committed under `src/generated/` — do not hand-edit;
  regenerate via `prisma generate`.

### Security invariants (do not weaken)

- bcrypt(10) password hashing; JWTs carry minimal payload (`sub`, `iat`, `exp`,
  `tokenVersion`).
- Refresh tokens stored as SHA-256 hashes with rotation + reuse detection.
- Content-type allow-list enforced on both upload-url and registration endpoints.
- Registration HEADs the S3 object and rejects size mismatches.
- Env is validated at boot (`src/config/env.ts`) — add new vars there, fail fast.

## Testing notes

- Tests hit a real Postgres test DB (`secure_file_storage_test`); `fileParallelism`
  is intentionally `false` to avoid truncation races between suites.
- S3 is always mocked in tests except where explicitly noted.
- When adding an endpoint or fixing a bug, add/extend a suite in `backend/tests/`
  following the existing naming (`auth.test.ts`, `quota.test.ts`, etc.).

## Pending work (as of IMPLEMENTATION_PLAN.md v1)

Execution now tracks `IMPLEMENTATION_PLAN.md` (hybrid of UPGRADE_PLAN, REMAINING_WORK,
SECURITY_ANALYSIS). Phase 1 (critical fixes: log redaction, BigInt fileSize migration,
secret floors, seed guard) is ✅ done. Next up:

1. Phase 2 — repo consolidation + CI workflow with working `npm audit` + Dependabot.
2. Phase 3 — real logout (call `/auth/logout`), transactional refresh rotation,
   timing-flat login, MinIO bucket CORS/ETag.
3. Phase 4 — forgot/reset-password endpoints (`PasswordResetToken` table exists) + pages.
4. Phase 5 — upload/content defense: drop SVG from allow-list, force attachment
   downloads, magic-byte sniffing, file-count cap.
5. Phases 6–8 per IMPLEMENTATION_PLAN.md.
