# Secure File Storage — Master Implementation Plan (Hybrid)

> Status: v1 — 2026-08-22
> This is the **single execution plan** for everything that remains in the project. It merges
> and supersedes the planning content of the three analysis documents:
>
> | Source doc | Role in this plan |
> | ---------- | ----------------- |
> | `UPGRADE_PLAN.md` (v10) | Historical record of what was built; its pending items are absorbed here |
> | `REMAINING_WORK.md` | Functional gaps (`R#`) + audit findings (`F#`) — item IDs reused below |
> | `SECURITY_ANALYSIS.md` | Security findings (`SEC-##`) + hardening phases — findings IDs reused below |
>
> When an item completes, tick it here **and** update the status line in its source document.
> `AGENTS.md` → "Pending work" section should also be kept in sync.

---

## 0. Current state snapshot

**Done & verified** (details in source docs): full modular backend with zod validation,
presigned single-PUT + multipart uploads (≤ 5 GB), hashed rotating refresh tokens with reuse
detection, atomic storage quota, delete-order fix + reconcile job, structured logging +
request IDs, health/readiness, cursor pagination, ~90 green tests across 10 suites.

**In flight / done since the plans were written:**

- ✅ **R1 — Frontend refresh flow** (store refresh token, 401→refresh interceptor, serialized
  concurrent refreshes) — implemented, lint+build green, live contract smoke-tested, pushed to
  `secure-file-storage-frontend` as commit `3d7716c`.

**Top risks driving phase order:**

1. 🔴 SEC-01 — bearer tokens logged in plaintext (live-verified)
2. 🟠 R5/`fileSize Int` — API promises 5 GB but Postgres `INTEGER` overflows at ~2 GiB
3. 🟠 SEC-02 — SVG stored-XSS via public share links (+ localStorage tokens = full session theft chain)
4. 🟠 SEC-04 — rate limiting silently broken on Vercel serverless target
5. 🟠 SEC-10/R3 — no CI, no dependency-vulnerability visibility anywhere

---

## How this plan is organized

Eight phases. Each phase is an **independent, shippable unit**: it has its own scope, file
list, verification steps, acceptance criteria, and can be merged/released alone. Functional
and security work that touches the same code is deliberately co-located in one phase so no
phase contains a half-migration of anything. Phases may be executed in any order, but the
numbering reflects recommended sequencing (risk-per-effort). Effort: S < 1 day · M 1–3 d · L > 3 d.

| Phase | Name | Absorbs | Effort |
| ----- | ---- | ------- | ------ |
| 1 | Critical fixes & kill-chain breakers | SEC-A, R5, F4 | M |
| 2 | Repo consolidation, CI & supply chain | R11, R3, SEC-B | M |
| 3 | Session lifecycle completion | R2, C1†, C2† (SEC-05†, SEC-07), F3 | S–M |
| 4 | Password reset end-to-end | R4, C4† (SEC-18), C5† (SEC-17) | M |
| 5 | Upload & content defense | SEC-D, F3-frontend-half | M |
| 6 | Abuse prevention & enumeration | R6, R7, SEC-E remainder, F1, F5 | M–L |
| 7 | API surface & reliability polish | R8, R9, R10, F6, docs DoD items | M |
| 8 | Observability, ops & optional extras | SEC-F, R12, F10, frontend extras | M |

† Security-analysis phase labels (C1/C2/C4/C5) are folded into functional phases where they share files.

---

## Phase 1 — Critical fixes & kill-chain breakers ✅ DONE (2026-08-22)

> Goal: eliminate the verified critical exposure and the two highest-severity design gaps.
> Fixes: SEC-01, SEC-12, SEC-13, SEC-15, SEC-18(log/error halves), R5, F4.
> Depends on: nothing. Effort: M.

> **Implemented:** pino-http request/response serializers now whitelist fields only
> (`utils/log-serializers.ts`) — headers/body never reach logs; pino `redact` paths for
> authorization/cookie/password/refreshToken as defense in depth (`utils/logger.ts`);
> logged URLs stripped of query strings (`utils/log-sanitize.ts`, presigned signatures);
> unexpected errors serialized to `{name, message}` (+stack dev-only); JWT_SECRET floor
> raised to 32 chars + placeholder rejection; stale Supabase creds in local `.env`
> replaced with local compose Postgres; seed refuses under NODE_ENV=production without
> `--force`; `/health` returns `{status:"ok"}` only; `*_EXPIRATION_MS` → `*_EXPIRATION_SECONDS`;
> **R5 BigInt migration** `20260822064220_convert_file_size_to_bigint` (File +
> MultipartUpload fileSize → BIGINT) with `serializeFile` mapper at every JSON response
> site and a 3 GB multipart regression test.
> New suite `tests/log-hygiene.test.ts`. Live smoke: authenticated traffic produced
> zero `eyJ`/signature substrings in captured logs; health shape verified; seed guard
> exits 1 in production mode. Gates: typecheck/lint/format:check/test all green (78 tests).

### Backend work

1. **Log redaction (SEC-01)** — custom pino-http request serializer whitelisting only
   `id/method/url/requestId/responseTime`; never serialize headers/body. Add pino `redact`
   rules for `authorization`/`cookie` as defense in depth.
   Files: `src/app.ts`, `src/utils/logger.ts`.
2. **URL signature redaction (SEC-18 part)** — strip query strings from logged URLs
   (presigned URLs carry signatures).
3. **Error serialization (SEC-18 part)** — log only `{name, message}` (+stack in dev) for
   unexpected errors. File: `src/middleware/error.middleware.ts`.
4. **Secret floors (SEC-12)** — `JWT_SECRET` ≥ 32 chars, reject placeholder values;
   purge stale cloud DB creds from local `.env`. File: `src/config/env.ts`.
5. **Seed guard (SEC-13)** — hard-fail unless `NODE_ENV !== 'production'` or `--force`.
   File: `src/seed.ts`.
6. **Health hardening (SEC-15)** — drop `uptime` from `/health`; update test.
7. **BigInt migration (R5 🔴)** — `File.fileSize` + `MultipartUpload.fileSize` → `BigInt`
   via new additive migration; mirror existing BigInt quota math patterns; keep JSON-safe
   number conversion at the API edge.
   Files: `prisma/schema.prisma`, migration, `file.service.ts` (quota math, HEAD size check),
   `tests/quota.test.ts` + new regression test registering >2 GB metadata (mocked HEAD).
8. **Constant rename (F4)** — `UPLOAD_URL_EXPIRATION_MS` → `_SECONDS` (it is seconds per S3 SDK contract).

### Verification

- New test: authenticated request → capture logs → assert no `Bearer `/`eyJ` substring appears.
- Env boot fails on a 16-char secret.
- Registration path accepts metadata for a >2 GiB object (mocked HEAD) without overflow.
- Full gates: `typecheck`, `lint`, `format:check`, `test`.

---

## Phase 2 — Repo consolidation, CI & supply chain ✅ DONE (2026-08-22)

> **Implemented:** consolidated into monorepo `tarekul42/secure-file-storage` via subtree
> merges (backend 22 commits + frontend 6 commits, full history preserved under `backend/`
> and `frontend/`); unified root `.gitignore`; `.github/workflows/ci.yml` (backend: audit +
> prisma generate + generated-client sync check + typecheck + lint + format + validate +
> migrate deploy + tests against Postgres service; frontend: audit + lint + build; registry
> pinned to npmjs.org); Dependabot config (npm ×2 + github-actions, weekly); removed unused
> `react-dropzone`. Generated client kept committed by policy with CI sync check.
> Known open advisory documented in workflow (prisma dev CLI → deepmerge-ts
> GHSA-ggr8-5vv4-36mx, no patched 7.x yet) — audit step non-blocking for that only.
> First CI run green. Old repos left intact for archiving by owner.

> Goal: one repo, automated gates on every push, dependency vulnerability visibility restored.
> Absorbs: R11, R3, SEC-B (SEC-10), F9. Depends on: nothing (Phase 1 not required first).
> Effort: M.

1. **Consolidate repos (R11)** — merge `backend/.git` + `frontend/.git` into a single root
   repo; unified `.gitignore`; decide generated-client policy (stop committing
   `backend/src/generated/` + generate in CI/build, or keep + CI sync check).
   Preserve both repos' history if feasible (subtree merge) or start fresh with a tagged archive.
2. **CI workflow (R3/SEC-B)** — `.github/workflows/ci.yml`: pin official npm registry
   (fixes dead `npm audit` on npmmirror); backend job = install → `npm audit --audit-level=high`
   → typecheck → lint → format:check → `prisma validate` → tests (Postgres service on :5434);
   frontend job = install → audit → lint → build.
3. **Dependabot** — version + security updates config per package ecosystem.
4. **Dead deps (F9)** — remove unused `react-dropzone`; prune others found.
5. Update local git remotes/branch protection once consolidated.

### Verification

- Green CI run on GitHub runners including a working `npm audit` result.
- Dependabot opens valid config PRs.
- Single-repo clone builds both apps following README instructions.

---

## Phase 3 — Session lifecycle completion

> Goal: finish what R1 started — logout revokes server-side, rotation is crash-safe, login
> timing is flat. Absorbs: R2, SEC-07 (F2), SEC-05-timing (C1), F3 (MinIO CORS + ETag loudness).
> Depends on: nothing (R1 already shipped). Effort: S–M.

1. **Real logout (R2)** — frontend calls `POST /auth/logout` with the stored refresh token
   (fire-and-forget acceptable) before clearing state. File: `frontend/src/lib/auth.tsx`.
2. **Transactional refresh rotation (SEC-07/F2)** — create-new-token + mark-`replacedById`
   inside one `$transaction`. Extend `tests/refresh.test.ts` with a mid-rotation failure case.
3. **Timing-flattened login (SEC-05 part)** — constant-work bcrypt compare against a fixed
   dummy hash when user unknown; benchmark assertion for response-time parity.
4. **MinIO bucket CORS (F3 infra half)** — add CORS config step to `storage-init` in
   `docker-compose.yml` exposing `ETag` on PUT; document prod-bucket equivalent.
5. **Loud ETag handling (F3 frontend half)** — fail the upload with a clear error when the
   part-PUT response has no readable `ETag`, instead of sending `""` and failing opaquely at
   complete. File: `frontend/src/app/components/FileUpload.tsx`.
6. Remove hardcoded demo credentials from `AuthForm` behind an env flag (F8, cheap while here).

### Verification

- Logout leaves zero active `RefreshToken` rows for the user (DB assert in e2e/manual pass).
- Refresh reuse-detection suite still green + new crash-simulation case passes.
- Timing benchmark test shows unknown-email vs wrong-password delta within noise threshold.
- Local multipart upload round-trips through MinIO with configured CORS.

---

## Phase 4 — Password reset end-to-end

> Goal: close the account-recovery gap (security feature, not just UX).
> Absorbs: R4, SEC-18 (reset flow), SEC-17 (bcrypt cost). Depends on: nothing.
> Effort: M.

### Backend

1. `POST /api/auth/forgot-password` — always 200; create single-use SHA-256-hashed token
   (reuse `PasswordResetToken` table + `hashToken` pattern), short TTL (~15 min).
2. `POST /api/auth/reset-password` — verify token (unused + unexpired atomically), set new
   bcrypt hash, revoke all refresh families + bump `tokenVersion` (kills old sessions).
3. Mailer interface; dev/test transport logs the reset link via pino.
4. bcrypt cost env-configurable (validated 10–14) + progressive rehash on login (SEC-17).

### Frontend

5. "Forgot password?" link on login page; `/forgot-password` and `/reset-password` pages
   consuming the token from query string.

### Tests & verification

- `tests/password-reset.test.ts`: token single-use, expiry enforced, enumeration-safe
  responses, sessions revoked after reset, old password rejected/new accepted.
- Manual pass: request link → open logged link → reset → prior session dies on next request.

---

## Phase 5 — Upload & content defense

> Goal: uploaded content can never execute or misrepresent itself; quota intent holds at row level.
> Absorbs: SEC-D (SEC-02, SEC-03, SEC-11), REMAINING_WORK F3 leftovers if any.
> Depends on: nothing (independent of Phases 3–4). Effort: M.

1. **Drop SVG from default allow-list (SEC-02)** — overridable via env with documented warnings.
2. **Force-download semantics (SEC-02 depth)** — sign all download/share URLs with
   `response-content-disposition: attachment` (+ optional content-type override).
3. **Magic-byte sniffing (SEC-03)** — at registration, ranged GET first KB, compare sniffed vs
   declared type, reject mismatch; runs alongside existing HEAD size check.
4. **Row-level quota hygiene (SEC-11)** — require `fileSize > 0`; configurable per-user file-count cap enforced inside the registration transaction (same atomic pattern as byte quota).

### Verification

- Malicious SVG rejected by default; any download arrives as attachment (header asserted in tests).
- PNG renamed/labeled `text/plain` rejected at registration.
- 0-byte upload rejected; count-cap exceeded rejected atomically under concurrency test.

---

## Phase 6 — Abuse prevention & enumeration defenses

> Goal: limits that actually hold in production topology; no account/file existence oracles.
> Absorbs: R6, R7, SEC-04, SEC-05-lockout, SEC-06, SEC-09/F1, F5. Depends on: vendor decision
> (Upstash/Vercel KV/self-host Redis) — make it before starting. Effort: M–L.

1. **Shared rate-limit store (SEC-04)** — Redis-backed store for express-rate-limit (or
   platform WAF); memory fallback stays for dev/test. Extract limiter factories to
   `src/middleware/rate-limit.ts` (matches UPGRADE_PLAN target map).
2. **Limit policy (R7)** — global (~100 req/min/IP) + named route limiters: auth (existing),
   upload-url/multipart-start, download, share.
3. **Per-account lockout (R6/SEC-05)** — failed-attempt counter + exponential backoff on the
   shared store; pairs with Phase 3's flattened timing.
4. **Uniform share 404 (SEC-09/F1)** — private and missing files indistinguishable on
   `GET /files/:id/share`; dedicated limiter on the route.
5. **Register-enumeration decision (SEC-06)** — document the 409 trade-off or move to
   generic-response flow once email verification exists.
6. **Rate-limit test coverage (F5)** — suites exercising limiter behavior against the shared
   store (integration w/ Redis container) incl. multi-instance semantics simulation.

### Verification

- Limits hold across simulated multi-instance execution; lockout returns 429 + Retry-After.
- Share route responses identical (status, body shape, timing) for private vs missing IDs.
- Load-test smoke confirms global cap; all gates green.

---

## Phase 7 — API surface & reliability polish

> Goal: remaining planned features + resilience tuning; bring docs to definition-of-done.
> Absorbs: R8, R9, R10, F6, plus UPGRADE_PLAN §7 leftover "document endpoints" item.
> Depends on: nothing. Effort: M.

1. **Search/filter (R8)** — `q` (case-insensitive fileName contains) + `visibility` params on
   `GET /files`, composable with cursor pagination; extend pagination tests.
2. **Idempotency-Key (R9)** — header support on `POST /files` (optionally multipart/complete);
   replay-safe duplicate registration prevention.
3. **Downstream resilience (R10)** — explicit S3 client timeouts/retry mode; Prisma pool
   sizing/connection timeout; verify reconnect after Postgres restart.
4. **Logging convention sweep (F6)** — route `seed.ts` boot output through pino-style logging
   where sensible; keep console only where logger unavailable pre-env-validation (document why).
5. **README API reference** — every endpoint incl. refresh/logout/reset/multipart/pagination
   shapes (UPGRADE_PLAN DoD item still outstanding).

### Verification

- Search returns correct filtered pages walking cursor without gaps/dupes.
- Duplicate `POST /files` with same Idempotency-Key returns the original record, not 409/duplicate.
- Chaos check: restart Postgres mid-run → app recovers without redeploy.

---

## Phase 8 — Observability, ops & optional extras

> Goal: incident readiness + the nice-to-haves. Absorbs: SEC-F (SEC-14 remainder, SEC-16),
> R12, F10, frontend extras. Depends on: nothing strictly; benefits from Phase 2 CI.
> Effort: M.

1. **Audit trail (SEC-16)** — additive `AuditLog` model (actor, action, targetType/id, ip,
   requestId, createdAt); instrument delete, visibility toggle, logout-all, password reset.
2. **Scheduled reconcile (SEC-16)** — cron for orphan sweep + stale multipart abort; alert on nonzero findings.
3. **Infra baseline (SEC-14)** — prod bucket checklist (SSE enforced, ACLs blocked, CORS limited to frontend origin w/ `ExposeHeaders: etag`); startup guard rejecting wildcard origin with `credentials: true`.
4. **Incident runbook (SEC-14)** — JWT_SECRET rotation via mass `tokenVersion` bump, refresh-family mass revocation, DB credential swap procedure.
5. **Admin module (R12, optional)** — `requireAdmin` middleware (role column exists), user list, quota overrides.
6. **Upload throughput (F10, optional)** — 2–4 parallel multipart part PUTs with correct aggregate progress.
7. **Frontend extras (optional)** — quota usage bar on Dashboard (data already returned by API), infinite scroll replacing "Load more".

### Verification

- Every sensitive action in the manual pass produces an audit row.
- Reconcile runs unattended on schedule and reports findings count.
- Tabletop walkthrough of the runbook completed.

---

## Cross-phase tracking & conventions

- **Definition of done per phase:** `typecheck` + `lint` + `format:check` + `test` green
  locally; CI green after Phase 2; new behavior covered by tests following existing suite
  naming; manual pass relevant to the phase's scope.
- **Status sync:** update this file, the corresponding source-doc status line
  (`UPGRADE_PLAN.md` / `REMAINING_WORK.md` / `SECURITY_ANALYSIS.md`), and `AGENTS.md`
  pending-work list in the same change.
- **Commit style:** conventional commits per repo area (`feat:`, `fix:`, `chore:`,
  `security:`), one logical unit per commit; push to the consolidated repo after Phase 2.
- **Manual regression pass (after any auth/upload-affecting phase):** register → login →
  idle past 15 min → auto-recovery via refresh → small upload → >100 MB multipart → toggle
  public/private → unauthenticated share download → delete → logout kills server session.

## Recommended execution order & risk payoff

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6 ──► Phase 7 ──► Phase 8
 critical    gates      session     recovery     content      abuse        polish       ops
             +repo      lifecycle                defense      defense
```

Fastest risk reduction: **Phases 1 + 5 together break the token-theft kill chain**
(log leakage gone + XSS vector closed + forced downloads), taking overall risk from High to
Medium before any infrastructure work lands. Phase 2 then makes everything after it
continuously verifiable.
