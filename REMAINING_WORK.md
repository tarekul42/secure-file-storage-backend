# Secure File Storage — Remaining Work & Findings Plan

> Status: v1 — created after a full line-by-line audit of the codebase (backend, frontend,
> tests, schema, configs) on 2026-08-22.
> Companion to `UPGRADE_PLAN.md` (v10). That plan tracks what was built; **this** plan tracks
> everything still missing, plus issues discovered during the audit that the original plan
> does not mention.
>
> Legend: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low/nice-to-have

---

## 1. Where the project stands

The backend has shifted from "assignment baseline" to genuinely production-leaning:
modular architecture, zod validation everywhere, atomic quota writes, presigned single-PUT
(≤ 100 MB) + multipart (≤ 5 GB) uploads, refresh-token rotation with reuse detection,
delete-order fix + reconcile job, structured logging with request IDs, health/readiness,
cursor pagination — all covered by ~90 green test cases across 10 Vitest suites.

**The weak flank has moved entirely to the frontend**, which ignores half the API contract
that motivated it: refresh tokens are never stored, logout never revokes server-side, quota
data is returned but never shown. Two latent backend issues also need attention before the
"5 GB" promise can be trusted.

---

## 2. Verified implemented (audit result — no action needed)

Confirmed in code, not just per plan claims:

| Area | Where |
| ---- | ----- |
| Modular per-feature layout (`routes/controller/service/validation/interfaces/constants`) | `src/modules/{auth,files,health}/` |
| zod validation of body/query/params; Express 5 getter-only `req.query` workaround | `middleware/validate.middleware.ts` |
| Centralized `ApiError` handling + structured pino logging with request id | `middleware/error.middleware.ts`, `utils/logger.ts`, `middleware/request-id.ts` |
| bcrypt(10), JWT 15 m with `tokenVersion` checked against DB per request | `auth.middleware.ts`, `modules/auth/` |
| Refresh tokens: opaque, SHA-256-hashed, family-based rotation **with reuse detection**; `/logout`, `/logout-all` (revokes tokens AND bumps `tokenVersion`) | `auth.service.ts`, `tests/refresh.test.ts` |
| Storage quota: advisory pre-check + atomic conditional `UPDATE … WHERE storageUsed + n <= storageLimit` in a transaction (TOCTOU-safe); `GREATEST(0,…)` decrement on delete | `file.service.ts` (`registerObject`, `deleteFile`), `tests/quota.test.ts` |
| Presigned single-PUT ≤ 100 MB; owner-namespaced keys `<ownerId>/<uuid>-<name>`; filename sanitization | `file.service.ts` |
| Full multipart flow: start / part-url / complete / abort; part-set validated (all parts 1..N exactly once); completion reuses registration path (HEAD + atomic quota); stale-upload sweep in reconcile job | `file.service.ts`, `jobs/reconcile.ts`, `tests/multipart.test.ts` |
| Content-type allow-list enforced at upload-url, metadata registration **and** multipart start | `file.validation.ts`, `config/env.ts` |
| Integrity: HEAD-before-register (400 if object missing / size mismatch); etag stored; checksum = etag for single-PUT only (multipart ETags are not MD5) | `registerObject`, `tests/content-safety.test.ts` |
| Delete ordering: DB row + quota first, best-effort S3 delete with logged fallback | `deleteFile`, `tests/delete-order.test.ts` |
| Reconcile job: orphaned-key sweep guarded by app-key regex, `--missing` scan, stale multipart abort, dry-run default | `jobs/reconcile.ts`, `tests/reconcile.test.ts` |
| Health: `/health` liveness; `/health/ready` checks Postgres `SELECT 1` + S3 `HeadBucket`, 503 when degraded | `modules/health/`, `tests/health.test.ts` |
| Cursor pagination on `GET /api/files` (limit cap 50, stable `createdAt desc, id desc`, `nextCursor`) | `listUserFiles`, `tests/pagination.test.ts` |
| Tests: 10 suites / ~90 cases against real Postgres (`secure_file_storage_test`), S3 mocked per-file via `vi.mock` | `backend/tests/` |
| Lint/format/typecheck gates wired as npm scripts | `eslint.config.mjs`, `.prettierrc.json`, `package.json` |
| Frontend: login/register/share/dashboard pages, `RequireAuth`, axios error extraction, "Load more" pagination, multipart upload >100 MB with chunked progress bar | `frontend/src/app/…`, `frontend/src/lib/` |

---

## 3. Critical path — do these first

### R1. Frontend refresh-token flow 🟠 (biggest functional gap in the product)

The backend refresh machinery is complete and tested but **dead code from the browser's
perspective**:

- `frontend/src/lib/auth.tsx` stores only `data.token`; the `AuthResponse` type in
  `lib/types.ts` omits `refreshToken` entirely.
- Result: every session hard-dies when the 15-minute access token expires.

Work items:
1. Add `refreshToken` to `AuthResponse`; store it alongside `token` in localStorage
   (or better: keep both keys managed in one place).
2. Add a **401 → refresh interceptor** in `frontend/src/lib/api.ts`: on 401 (except from
   `/auth/login`, `/auth/register`, `/auth/refresh` itself), call `POST /api/auth/refresh`,
   persist the rotated pair, retry the original request once. Queue concurrent 401s behind a
   single in-flight refresh. On refresh failure → clear storage and redirect to `/login`.
3. Update `AuthProvider` bootstrap (`GET /auth/me`) to rely on the interceptor instead of
   hard-clearing the token on first failure.
4. Test manually: idle 16 minutes → next action silently recovers the session.

### R2. Real logout 🟡

`logout()` in `auth.tsx` only clears localStorage — the server-side refresh token stays
valid until its 30-day expiry. Call `POST /api/auth/logout` (fire-and-forget is fine) before
clearing local state.

### R3. CI workflow 🟠 ✅ DONE (Phase 2 of IMPLEMENTATION_PLAN.md)

No `.github/workflows/ci.yml` exists anywhere (root, `backend/`, `frontend/`). All gates
already exist as scripts — wiring them up is mechanical:

- Job 1 (backend): checkout → setup-node → `npm ci` → `prisma generate` →
  `typecheck` → `lint` → `format:check` → `prisma validate`.
- Job 2 (backend tests): spin up Postgres :5434 (services block mirroring
  `docker-compose.yml`), apply migrations to `secure_file_storage_test`, run `npm test`.
  S3 stays mocked, so MinIO is not required in CI.
- Job 3 (frontend): `npm ci` → `lint` → `build`.

### R4. Forgot / reset password 🟡

`PasswordResetToken` table exists (hashed token, `expiresAt`, `usedAt`) but nothing uses it.

- Backend: `POST /api/auth/forgot-password` (always 200 regardless of account existence;
  create short-lived hashed token) + `POST /api/auth/reset-password` (validate token,
  set bcrypt hash, revoke all refresh tokens + bump `tokenVersion` so old sessions die).
- Email sending: abstract behind an interface; log the reset link via `logger` in dev /
  return it in test mode. No SMTP dependency needed for the assignment.
- Frontend: "Forgot password?" link on login page + `/reset-password` page consuming the
  token from the query string.
- Reuse the existing `hashToken` pattern from `auth.service.ts`.
- Tests: `tests/password-reset.test.ts` following existing suite conventions.

### R5. File size column overflow vs the 5 GB promise 🔴 ✅ DONE (Phase 1 of IMPLEMENTATION_PLAN.md)

`prisma/schema.prisma` declares `File.fileSize Int` and `MultipartUpload.fileSize Int`.
Postgres `INTEGER` overflows at **2,147,483,647 bytes (~2.1 GB)** while the API advertises
and validates up to 5 GB (`MULTIPART_MAX_SIZE_BYTES`). Any multipart file ≥ 2 GiB will fail
quota math and/or registration at runtime.

Options (pick one):
- **A (recommended):** migrate both columns to `BigInt`, update service math accordingly
  (mirror the existing BigInt quota pattern), add a regression test registering a >2 GB
  *metadata* record (mock S3 HEAD).
- **B:** lower `MULTIPART_MAX_SIZE_BYTES` to 2 GB and adjust validation messages/frontend
  copy. Cheaper, but shrinks the advertised capability.

---

## 4. Backend gaps carried over from UPGRADE_PLAN (still pending)

### R6. Per-account login throttling 🟡 (P1-3)

Currently only a flat IP limiter (20 req / 15 min) on register/login/refresh
(`auth.routes.ts`). Add failed-attempt tracking per email (+IP): exponential backoff or
temporary lockout, stored either in a small table or an in-memory LRU (document the
trade-off). Keep responses timing-safe: same message and comparable latency for unknown
user and wrong password (already true message-wise).

### R7. Global + per-route rate limiting policy 🟡 (P4-3)

There is **no global limiter**; files endpoints are unlimited. Plan:

- Global limiter (~100 req/min/IP) applied in `app.ts`.
- Dedicated stricter limiters: `POST /files/upload-url`, `multipart/start`,
  `GET /files/:id/download`, and especially `GET /files/:id/share` (unauthenticated).
- Extract limiter factories into `middleware/rate-limit.ts` (matches the target file map).

### R8. Search / filtering on file list ⚪ (P4-2)

Extend `listFilesQuerySchema` + `listUserFiles` with optional `q` (case-insensitive
fileName `contains`) and `visibility` filter. Composable with cursor pagination — decide
ordering interaction explicitly (`q` matches may not be createdAt-contiguous; that's fine
as long as ordering stays stable). Extend `tests/pagination.test.ts` or add
`tests/search.test.ts`.

### R9. Idempotency-Key on metadata registration ⚪ (P3-5)

Client retries after timeout can double-register. Accept `Idempotency-Key` header on
`POST /files` (and optionally `multipart/complete`); cache key → response for ~24 h
(DB table or keyed unique constraint on `(ownerId, s3Key)` as a simpler proxy).

### R10. Downstream resilience tuning ⚪ (P3-4)

- `db/s3.ts`: explicit `requestHandler` timeouts + SDK retry mode (e.g. `adaptive`,
  maxAttempts 3).
- `db/prisma.ts`: pool sizing / connection timeout via `PrismaPg` options; verify
  reconnection after a Postgres restart.

### R11. Repo consolidation ⚪ ✅ DONE (Phase 2 of IMPLEMENTATION_PLAN.md)

Root has **no** `.git`; `backend/` and `frontend/` each have their own. Merge into one repo
at the root with unified `.gitignore`. Decide on `backend/src/generated/`: either stop
committing it (generate in CI/build) or keep it and let CI verify sync (`prisma validate`
+ diff check). Do this before R3 lands so CI lives in the consolidated repo.

### R12. Optional: admin module ⚪ (P4-4)

Only if multi-tenant admin is desired: `requireAdmin` middleware using the existing
`User.role`, list users, override quotas, review content. Schema already supports it.

---

## 5. Additional findings from the audit (not in UPGRADE_PLAN)

| # | Finding | Severity | Detail / fix |
| - | ------- | -------- | ------------ |
| F1 | Share endpoint metadata probing | Medium-Low | Unauthenticated `GET /files/:id/share` distinguishes 404 ("File not found") vs 403 ("no access"), enabling existence probing of private files by ID; endpoint also has no rate limit. Fix options: uniform 404 for both cases on the share route, plus the R7 rate limit. |
| F2 | Refresh rotation is not transactional | Low | `auth.service.ts:209-221` creates the new token then marks `replacedById` in two separate writes. A crash between them leaves an orphan that can still refresh once. Not exploitable for family takeover, but wrap both writes in `$transaction` when convenient. |
| F3 | Multipart ETag depends on bucket CORS config | Low-Medium | `FileUpload.tsx:96` reads `response.headers.etag` off the presigned PUT; browsers expose `ETag` only if bucket CORS sets `Access-Control-Expose-Headers: etag`. The MinIO init container in `docker-compose.yml` creates the bucket but configures **no CORS**, so local multipart uploads can fail with empty ETags depending on client defaults. Add an `mc cors set`/anonymous-CORS step to `storage-init` and document the production-bucket requirement. Also make the frontend fail loudly (not `?? ""`) when the ETag header is absent. |
| F4 | Misleading constant name | Trivial ✅ done | `FILE_LIMITS.UPLOAD_URL_EXPIRATION_MS = 60 * 60` is seconds (S3 SDK contract). Renamed to `_SECONDS` (Phase 1). |
| F5 | Rate-limiting behavior untested | Low | Definition of done mentions rate-limit coverage; none exists. Feasible with vi.useFakeTimers or a tiny window. |
| F6 | `console.*` usage | Trivial | `seed.ts` and boot-time env failure in `config/env.ts` use console; acceptable for scripts/boot, could route through pino for consistency. |
| F7 | Test truncation model | Info | `tests/setup.ts` truncates `"User" CASCADE` once per file (`beforeAll`), so suites share state within a file. Fine today; keep in mind when extending suites. |
| F8 | Hardcoded demo credentials in UI | Info | `AuthForm.tsx` embeds `demo@example.com / password123`. Fine for assignment; remove before any real deployment. |
| F9 | Unused dependency | Trivial | `react-dropzone` is installed but unused (FileUpload uses a plain input). Remove or adopt. |
| F10 | Sequential multipart part uploads | Info | Parts upload one-at-a-time; concurrency (2–4 parallel PUTs) would improve large-file throughput. Optional enhancement, keep aggregate progress correct. |

---

## 6. Frontend gaps (§8 of UPGRADE_PLAN, restated with audit detail)

- [ ] **R1** — store refresh token + 401→refresh interceptor (critical)
- [ ] **R2** — server-side logout call
- [ ] Quota/usage UI: API already returns `storageUsed`/`storageLimit` on auth responses and
      `/me` — render a usage bar on the Dashboard
- [ ] Forgot/reset-password pages (pairs with R4)
- [ ] Consider moving refresh token to HttpOnly cookie long-term (out of scope for the
      assignment; note the CSRF implications if attempted)
- [ ] Optional: infinite-scroll instead of "Load more"

---

## 7. Suggested execution order

| # | Task | Priority | Est. effort | Depends on |
| - | ---- | -------- | ----------- | ---------- |
| 1 | R1 — Frontend refresh flow (store + interceptor) | High | M | — |
| 2 | R2 — Real logout | Medium | S | R1 |
| 3 | R3 — CI workflow | High | M | R11 (ideally first) |
| 4 | R4 — Forgot/reset password (API + pages) | Medium | M | — |
| 5 | R5 — fileSize BigInt migration (or cap at 2 GB) | High | S–M | — |
| 6 | F1 — Uniform 404 on share probing | Medium | S | — |
| 7 | F3 — MinIO bucket CORS in compose init + loud frontend ETag failure | Medium | S | — |
| 8 | R6 — Per-account login throttling | Medium | M | — |
| 9 | R7 — Global + per-route rate limits | Medium | S | — |
| 10 | R8 — Search/filter on file list | Low | S | — |
| 11 | R9 — Idempotency-Key | Low | S–M | — |
| 12 | R10 — S3/Prisma resilience tuning | Low | S | — |
| 13 | R11 — Repo consolidation + generated-client policy | Medium | S | before R3 |
| 14 | R12 — Admin module (optional) | Low | M | — |

Legend: **S** < 1 day · **M** 1–3 days.

If you only do five things: **R1, R2, R5, R3, R4** — those close every functional break
(users locked out at 15 min, sessions surviving logout, 5 GB lie, no CI, no account
recovery).

---

## 8. Definition of done (updated)

- From `backend/`: `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm test` — all green (compose stack up for tests).
- New/changed endpoints have test suites following existing naming conventions.
- Manual pass: register → login → **idle past 15 min → session auto-recovers via refresh**
  → upload small file → upload >100 MB via multipart → toggle public/private → share link
  works unauthenticated → download → delete → **logout invalidates the refresh token
  server-side**.
- Reset-password round trip works end-to-end (link logged in dev, token single-use, old
  sessions revoked).
- CI runs the full gate matrix on every push.
- Files ≥ 2 GiB either work end-to-end (BigInt path) or are rejected with a truthful limit.
