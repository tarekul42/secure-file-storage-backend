# Secure File Storage — Upgrade Plan

> Status: v10 — Phase 0, P1-1, P2-1, P2-2, P2-3, P2-4, P2-5, P3-1, P3-2, P3-3, P4-1 implemented ✅
> Scope: **Backend first** (frontend upgrades are tracked but sequenced after the API layer is hardened).
> Perspective: Senior web engineer review of the current implementation.

---

## 1. Executive summary

The backend is already well above the baseline for the assignment. It uses a clean modular
architecture (`constants / interfaces / validation / service / controller / routes` per
feature), zod validation, centralized error handling, bcrypt + JWT auth, helmet + CORS,
rate limiting, and S3 **presigned URLs** so large uploads never proxy through the API.

The biggest gaps are **not** in architecture — they are in **operational rigor**:

1. **Zero automated tests** and **no lint/format gates** — the single most important
   investment for a "production-quality" claim.
2. **Auth is functional but shallow** — no refresh tokens, no email verification, no
   password reset, no login throttling beyond a blanket limiter, no logout/revocation.
3. **Storage model is minimal** — no multipart/resumable uploads, no per-user storage
   quota, no content-type allow-list, no file versioning or dedup, no folders.
4. **Reliability gaps** — the delete flow (S3 then DB) can orphan objects on partial
   failure; no graceful handling of Prisma/S3 outages; no structured logging.
5. **No observability** — no request IDs, no structured logs, no metrics, no health/readiness
   distinction, no opentelemetry-style trace context.
6. **No pagination** on file listing; no search; the share endpoint accepts unauthenticated
   metadata probing.

---

## 2. What is already strong (keep it)

| Area | Why it's good |
| ---- | ------------- |
| Modular layout | Each feature is self-contained and independently testable. |
| Presigned URL upload/download | API stays stateless for large transfers; 100 MB cap enforced. |
| zod validation middleware | Body/query/params validated separately; consistent error shape. |
| Centralized `ApiError` + handlers | Clean, predictable error contract. |
| Env validation at boot | Fails fast on misconfiguration. |
| Security baseline | bcrypt(10), JWT expiry, helmet, CORS allow-list, auth rate limit. |
| Owner-namespaced S3 keys | `ownerId/uuid-name` prevents cross-tenant key spoofing. |
| Graceful shutdown | `SIGINT`/`SIGTERM` close server + disconnect Prisma. |

**Do not** rewrite these. The plan builds on top of them.

---

## 3. Backend gaps — prioritized roadmap

### Phase 0 — Engineering foundations (do this first, highest ROI)

**P0-1. Add automated tests (critical).** ✅ DONE
- Test runner: **Vitest** (fast, TS-native, works with ESM) + `supertest` for HTTP tests.
- Mock Prisma with a shared `test` DB (Postgres via docker-compose) or `pg-mem`. Prefer a real
  Postgres instance (matching prod) with a test database and transactional rollback per test.
- Coverage targets for new work: auth service + controller, files service (authz matrix),
  validation middleware, error middleware, rate limiting behavior.
- CI runs `typecheck`, `lint`, `test`, `prisma validate`.

> **Implemented:** `vitest.config.ts` + `tests/setup.ts` (dedicated local Postgres test DB
> `secure_file_storage_test`, migrations applied), `tests/auth.test.ts`, `tests/files.test.ts`
> (S3 mocked via `vi.mock`), `fileParallelism: false` to avoid cross-file truncation races.
> 20 tests green. Note: requires `docker compose up -d` (Postgres on :5434).

**P0-2. Lint + format gates.** ✅ DONE
- Add **ESLint 9 flat config** + **Prettier**, add `lint`/`format` scripts, wire into CI.
- Enforce import ordering and `type`-only imports for cleanliness.

> **Implemented:** `eslint.config.mjs` (typescript-eslint recommended, no-explicit-any,
> consistent-type-imports, underscore-ignored unused vars) + `.prettierrc.json` /
> `.prettierignore` (excludes `src/generated/`, `dist/`). Scripts: `lint`, `lint:fix`,
> `format`, `format:check`. All gates green: `typecheck`, `lint`, `format:check`, `test`.
> TODO next: wire into CI (.github/workflows/ci.yml) — pending repo consolidation (P0-3).

**P0-3. Repo hygiene.**
- Currently each subfolder (`backend/`, `frontend/`) has its own `.git`; the root has none.
  Consolidate to a single repo at the root with a unified `.gitignore`, `eslint`, `prettier`,
  and CI so PRs are cross-stack.
- Stop committing `backend/src/generated/*` — generate Prisma client at build/CI instead
  (see note below; if keeping, at least validate it's in sync via CI).

### Phase 1 — Authentication hardening

**P1-1. Refresh-token flow (access + refresh JWT pair).** ✅ DONE
- `accessToken` (short, e.g. 15 min) + `refreshToken` (long, e.g. 30 days, random opaque string).
- Store refresh tokens hashed in a `RefreshToken` table (device/browser-bound) so tokens can be
  **revoked** (logout, password change, breach).
- Add `POST /api/auth/refresh` and `POST /api/auth/logout` (revoke server-side).
- Rotate refresh token on every refresh (reuse detection → revoke family on reuse).

> **Implemented:** `RefreshToken` model + `add_refresh_tokens` migration. Tokens stored as
> SHA-256 hashes with a `familyId` (rotation lineage), `replacedById` (rotation chain) and
> `revokedAt`. Access JWT TTL lowered 7d → 15m; refresh TTL 30d. New endpoints:
> `POST /api/auth/refresh` (rotates + reuse detection revokes family), `POST /api/auth/logout`
> (revoke one), `POST /api/auth/logout-all` (revoke all). Responses keep `token` (access) for
> backward compat with the current frontend and add `refreshToken`.
> Tests: `tests/refresh.test.ts` (rotation, reuse detection, logout, logout-all).
> ⚠️ Frontend must add a 401 refresh interceptor (tracked in §8) — until then sessions end
> when the 15-min access token expires.

**P1-2. Account lifecycle endpoints.**
- `POST /api/auth/forgot-password` + `POST /api/auth/reset-password` (short-lived signed token).
- Optional: email verification (`POST /api/auth/verify-email`) — gate or flag users.

**P1-3. Login throttling & abuse protection.**
- Per-account failed-attempt tracking with exponential backoff / lockout, in addition to the
  global IP rate limiter.
- Keep auth endpoints off the default global limiter; use dedicated, stricter limits.

**P1-4. Token plumbing.**
- JWT payload stays minimal (`sub`, `iat`, `exp`, `tokenVersion` for revocation).
- Add an authz helper (`requireOwner`) to dedupe the repeated ownership checks in files service.

### Phase 2 — Storage & data model

**P2-1. Per-user storage quota.** ✅ DONE
- Add `storageUsed`/`storageLimit` to `User` (or a computed aggregate).
- Enforce at upload-url request time (reject 413 if exceeding); enforce on metadata registration
  inside a transaction to avoid TOCTOU races.

> **Implemented:** `User.storageUsed` / `User.storageLimit` (BigInt, default 1 GiB) via
> `add_storage_quota` migration. `POST /files/upload-url` rejects 413 up-front (advisory).
> `POST /files` reserves quota with an **atomic conditional `UPDATE ... WHERE storageUsed + n
> <= storageLimit`** inside a transaction (TOCTOU-safe), rolling back if the file row cannot be
> created. Deletes decrement with `GREATEST(0, …)`. Default limit configurable via
> `DEFAULT_STORAGE_LIMIT_BYTES`; `storageUsed`/`storageLimit` exposed on `GET /me` and auth
> responses (as JSON-safe numbers). Tests: `tests/quota.test.ts`.

**P2-2. Multipart / resumable uploads (beyond 100 MB).** ✅ DONE
- Extend the presigned approach to S3 **multipart** (`CreateMultipartUpload`, `UploadPart`,
  `CompleteMultipartUpload`) or presigned **range** puts for resumability.
- Keep the current single-PUT path for small files; add the multipart path for larger ones.

> **Implemented:** full presigned-multipart flow for files **100 MB < size ≤ 5 GB** (8 MB
> parts, capped at 10 000 parts):
> - `POST /files/multipart/start` — validates the content-type allow-list + advisory quota,
>   creates the S3 upload, persists a `MultipartUpload` row, returns `uploadId`/`s3Key`/
>   `partSize`/`partCount`.
> - `POST /files/multipart/part-url` — returns a presigned `UploadPart` URL for a valid part
>   number (ownership + active-state checked each call, so resuming/re-requesting a part URL
>   is safe).
> - `POST /files/multipart/complete` — verifies all parts `1..partCount` are present exactly
>   once, completes the S3 upload, then reuses the same registration path as single-PUT
>   (HEAD size check + atomic quota reservation). Multipart ETags carry a `-N` suffix, so
>   `checksum` is stored as `null` (the ETag is not the content MD5).
> - `POST /files/multipart/abort` — aborts the S3 upload and marks the row.
> - The `reconcile` job now also lists in-progress multipart uploads (`ListMultipartUploads`)
>   and aborts stale ones older than 24 h (dry-run by default; `--apply` to act), plus marks
>   stale incomplete DB rows as aborted.
> - Frontend: files > 100 MB upload via the multipart path (chunked `File.slice` + presigned
>   PUT per part with aggregate progress); ≤ 100 MB keeps the single-PUT path. The 100 MB cap
>   is gone; the limit is now 5 GB.
> Tests: `tests/multipart.test.ts` (start/part-url/complete/abort, quota, authz, part-set
> validation), extended `tests/reconcile.test.ts`. Live-verified against MinIO with a real
> 101 MB file (13 parts) — byte-for-byte download round-trip.

**P2-3. Content-type allow-list (defense in depth).** ✅ DONE
- Validate `fileType` against a configurable allow-list (and/or magic-byte sniffing on
  register). Prevents abusing the storage bucket as a content host.

> **Implemented:** `ALLOWED_CONTENT_TYPES` (comma-separated, sensible default) validated at
> both `POST /upload-url` (`fileType`) and `POST /files` (`mimeType`) → 400 with a clear
> `errors[]` detail. Frontend falls back to `application/octet-stream` when the browser
> reports an empty type.

**P2-4. File lifecycle & integrity.** ✅ DONE
- Store `etag`/`contentMd5` on registration; optionally verify on download.
- Add `size` mismatch check: registered `fileSize` should match the object size reported by S3
  (HEAD) to catch truncated uploads.

> **Implemented:** `POST /files` now HEADs the object first — 400 if it doesn't exist
> (metadata can no longer be registered before upload) and 400 on size mismatch (truncated
> uploads). The object's ETag is stored as `File.etag` + `File.checksum` (single-part PUT,
> ETag = content MD5). New migration `20260819090209_add_file_etag_checksum`. Tests:
> `tests/content-safety.test.ts` (allow-list, missing object, size mismatch, etag capture).
> Also fixed the S3 test mocks: they stubbed every command as `class Command {}`, so
> `constructor.name` dispatch silently never matched — each command class now has its own
> name, making the delete-failure and HEAD paths genuinely exercised.

**P2-5. Schema additions (backwards-compatible, via new migration).** ✅ DONE
- `User`: `role` (optional admin), `storageLimit`, `storageUsed`, `isVerified`, `tokenVersion`.
- `File`: `checksum`, `etag`, `contentType`, optional `parentId` (folders later), `updatedAt`.
- `RefreshToken`, `PasswordResetToken` tables.

> **Implemented:** migration `20260819094225_add_p2_5_schema_backfill` adds `User.role`
> (`USER`/`ADMIN`, default USER), `User.isVerified` (false), `User.tokenVersion` (0),
> `File.parentId` (nullable, folders later) and `File.updatedAt` (`@updatedAt`, backfilled
> from `createdAt`). `RefreshToken` existed (refresh flow); new `PasswordResetToken` table for
> the upcoming reset-password item. `checksum`/`etag` came in P2-4; `contentType` is covered
> by the existing `mimeType`.
> **Wired into behavior:** the access JWT now carries `tokenVersion`, and `authenticate`
> compares it against the user's current version (one indexed PK lookup per request, which
> also rejects deleted accounts). `POST /logout-all` bumps `tokenVersion` so outstanding
> access tokens are invalidated immediately, not just refresh tokens. `role`/`isVerified` are
> exposed on auth responses and `/me`. `updatedAt` is auto-maintained on file updates.

### Phase 3 — Reliability, transactions & observability

**P3-1. Fix the delete flow (data-consistency).** ✅ DONE
- Current: `delete S3 object` then `delete DB row`. If DB delete fails, the S3 object is gone
  but metadata remains (dangling). Wrap in a safer order:
  1. Delete DB row first (source of truth), then
  2. Best-effort delete S3 object; log + enqueue a retry job if it fails.
  Add a periodic reconciliation job that finds DB rows whose S3 object is missing, and orphaned
  S3 keys without DB rows.

> **Implemented:** `deleteFile` now removes the DB row (and decrements quota) **first**, then
> best-effort deletes the S3 object — on failure it logs and leaves the object for cleanup.
> New `src/jobs/reconcile.ts` (`npm run reconcile`) lists all bucket objects and deletes
> **orphaned** keys (no matching DB row), guarded by an app key-shape regex
> (`<uuid>/<uuid>-<name>`) so unrelated bucket contents are never touched. **Dry-run by
> default**, pass `--apply` to delete; `--missing` reports DB rows whose object is gone.
> Verified live against MinIO. Tests: `tests/delete-order.test.ts` (DB cleaned even when S3
> delete fails), `tests/reconcile.test.ts` (key matching + orphan detection).

**P3-2. Structured logging + request IDs.** ✅ DONE
- Introduce a request-id middleware (correlation id) that surfaces in logs and `X-Request-Id`.
- Replace `console.log/error` with a structured logger (pino) with JSON output in prod.

> **Implemented:** `src/utils/logger.ts` (pino; pretty in dev, JSON in prod, silent in test),
> `src/middleware/request-id.ts` (correlation id, honours + echoes caller `X-Request-Id`),
> `pino-http` replaces morgan (auto request logging + request id), `error.middleware` logs
> structured errors with `requestId`/`method`/`url`. `morgan`/`@types/morgan` removed.
> Also fixed a pre-existing bug: `start` script now runs `node dist/src/index.js`
> (tsconfig `rootDir: "."` emits under `dist/src/`).

**P3-3. Health & readiness endpoints.** ✅ DONE
- `/health` (liveness) and `/health/ready` that check DB connectivity (and S3) so orchestrators
  and load balancers can route correctly.

> **Implemented:** `src/modules/health/` (`health.routes.ts` / `controller.ts` / `service.ts` /
> `interfaces.ts`). `/health` = liveness; `/health/ready` checks Postgres (`SELECT 1`) and S3
> (`HeadBucket`) and returns 503 with per-check detail when degraded. Shared S3 client extracted
> to `src/db/s3.ts` (reused by files service and health). Tests in `tests/health.test.ts`
> (liveness, readiness shape, request-id propagation).

**P3-4. Graceful handling of downstream outages.**
- Wrap S3 calls with timeouts/retries (the AWS SDK does some retries; configure explicitly).
- Ensure Prisma connection pooling is tuned (pool size, connection timeout) and that `prisma`
  can re-connect after Postgres restarts.

**P3-5. Idempotency.**
- Add an `Idempotency-Key` header handling on `POST /files` (metadata registration) to avoid
  duplicate metadata if the client retries after a timeout.

### Phase 4 — Performance, pagination & API surface

**P4-1. Pagination + cursor.** ✅ DONE
- `GET /api/files` → support `cursor` + `limit` (max 50) using cursor-based pagination
  (`createdAt`/`id`), return `nextCursor`.

> **Implemented:** `GET /api/files?limit=N&cursor=ID` returns `{ files, nextCursor }`
> (`limit` default 20, cap 50, rejected above). Cursor-based on stable
> `createdAt desc, id desc` ordering; `nextCursor` is `null` on the last page.
> Non-existent cursor → empty page; malformed cursor → 400. While here: **fixed a latent
> Express 5 bug** — `req.query` is a getter-only property, so the `validate` middleware
> crashed with 500 whenever a route validated query params; it now redefines the property
> instead of assigning. Frontend Dashboard reads the new shape and got a "Load more"
> button. Tests: `tests/pagination.test.ts` (first/last page, walk-all-pages, cap, invalid
> cursors).

**P4-2. Search / filtering.**
- Optional `q` (fileName), `visibility` filter, ordered by `createdAt` desc (already default).

**P4-3. Rate limiting policy review.**
- Apply a sensible global limiter (e.g. 100 req/min) plus tighter per-route limits
  (auth: already done; upload-url; download/share) to prevent abuse.

**P4-4. Optional admin module.**
- If multi-tenant/admin is desired: `GET /api/admin/users`, quota overrides, content review.

---

## 4. Backend file map (target state after upgrades)

```
backend/
├── src/
│   ├── config/env.ts                # + refresh/access TTLs, quota defaults, allow-list
│   ├── db/prisma.ts                 # pooled client, ready-check helper
│   ├── middleware/
│   │   ├── auth.middleware.ts       # access-token verify
│   │   ├── require-auth.ts          # optional-auth variant (for share)
│   │   ├── require-owner.ts         # authz helper
│   │   ├── rate-limit.ts            # named limiter factories
│   │   ├── request-id.ts            # correlation id
│   │   ├── validate.middleware.ts   # unchanged (reused)
│   │   └── error.middleware.ts      # + notFound unchanged; structured logging hook
│   ├── modules/
│   │   ├── auth/                    # + refresh/logout/forgot/reset/verify
│   │   ├── files/                   # + multipart, quota, pagination, checksum
│   │   ├── users/                   # (optional) profile, quota, admin
│   │   └── health/                  # liveness/readiness (or in app.ts)
│   ├── jobs/
│   │   └── reconcile.ts             # orphan/dangling object sweep
│   └── utils/                       # + logger, idempotency helper
├── tests/                           # Vitest + supertest suites
├── prisma/
│   ├── schema.prisma                # extended models
│   └── migrations/                  # new additive migrations
├── eslint.config.mjs
├── .prettierrc
└── .github/workflows/ci.yml
```

---

## 5. Dependencies to add (backend)

- `vitest`, `supertest`, `@types/supertest` (dev) — testing ✅ installed
- `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `prettier` (dev) — gates ✅ installed
- `pino`, `pino-http` — structured logging ✅ installed
- `pino-pretty` (dev) — pretty dev logs ✅ installed
- `@aws-sdk/lib-storage` (dev) — multipart upload support (already depends on `@aws-sdk/client-s3`)
- `uuid`/`crypto.randomUUID` (already available via Node) for tokens/keys
- `jose` or keep `jsonwebtoken` — fine either way; keep `jsonwebtoken` to minimize churn

---

## 6. Suggested execution order (backend)

| # | Task | Priority | Est. effort | Status |
| -- | ---- | -------- | ----------- | ------ |
| 1 | Set up Vitest + supertest + first auth & files test suite | Critical | M | ✅ done |
| 2 | Add ESLint + Prettier, scripts, run gates | Critical | S | ✅ done |
| 3 | Request-ID + structured logging (pino) | High | S | ✅ done |
| 4 | Health/readiness endpoints | High | S | ✅ done |
| 5 | Refresh-token flow + logout/revoke | High | L | ✅ done |
| 6 | Storage quota enforcement | High | M | ✅ done |
| 7 | Fix delete ordering + reconcile job | High | M | ✅ done |
| 8 | Pagination on file list | Medium | S | ✅ done |
| 9 | Content-type allow-list + size/checksum check | Medium | M | ✅ done |
| 10 | P2-5 schema backfill (role, isVerified, tokenVersion, updatedAt) | Medium | M | ✅ done |
| 11 | Multipart/resumable uploads | Medium | L | ✅ done |
| 12 | Forgot/reset password | Medium | M | ⏳ next |
| 13 | Global + per-route rate-limit policy | Medium | S | pending |
| 14 | CI pipeline (typecheck/lint/test/validate) | High | M | pending |
| 15 | Consolidate git repos + root hygiene | Medium | S | pending |

Legend: **S** < 1 day · **M** 1–3 days · **L** > 3 days.

---

## 7. Definition of done / verification

- `npm run typecheck`, `npm run lint`, `npm run format:check` all pass in CI.
- `npm test` runs a green suite covering: auth service, files authz matrix (owner/public/
  private/403), validation, error handler, rate limiting.
- `prisma migrate dev` produces clean additive migrations; `prisma validate` passes.
- Manual pass: register → login → upload small file → upload via multipart → toggle
  public/private → share link for unauthenticated user → download → delete.
- New backend endpoints documented in the README API reference.
- Storage quota rejects oversized uploads with a clean 413.

---

## 8. Frontend (tracked after backend, brief)

Not this phase, but noted so the API contract stays compatible:
- Swap JWT storage to refresh/access strategy (HttpOnly cookie for refresh recommended).
- Add quota/usage UI, upload progress for multipart, paginated list (infinite scroll).
- Add forgot/reset password pages.
- The frontend already uses axios; add 401-interceptor to trigger refresh flow.
