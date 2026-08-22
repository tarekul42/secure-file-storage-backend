# Secure File Storage Service

A full-stack file storage application where authenticated users can upload, manage, and
share files. Files are **private by default**; owners can flip any file to **public**,
which generates a shareable link that works for unauthenticated visitors. Private files
are only ever downloadable by their owner.

## Tech stack

| Layer     | Technology                                                        |
| --------- | ----------------------------------------------------------------- |
| Backend   | Node.js, TypeScript, Express 5, Prisma 7 (PostgreSQL driver adapter) |
| Database  | PostgreSQL                                                         |
| Storage   | S3-compatible, presigned URLs — runs on **AWS S3, MinIO, or Supabase Storage** |
| Frontend  | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4     |
| Validation | zod                                                              |
| Security  | bcryptjs, JWT (Bearer), helmet, cors, express-rate-limit          |

## Why presigned URLs

Uploads of up to **100 MB** are never proxied through the API server. The client asks the
backend for a short-lived **presigned S3 PUT URL**, uploads straight to S3 with real-time
progress, and only then registers the file metadata with the backend. Downloads work the
same way (presigned GET URLs). This keeps the API server stateless for large transfers and
avoids request-body size limits and multi-part buffering.

## Repository layout

```
secure-file-storage/
├── backend/
│   ├── prisma/                  # schema + migrations
│   └── src/
│       ├── config/env.ts        # zod-validated environment config
│       ├── db/prisma.ts         # PrismaClient (Pg driver adapter)
│       ├── middleware/          # auth, validation, error handling
│       ├── modules/             # feature modules (self-contained)
│       │   ├── auth/            # constants, interfaces, validation,
│       │   │                    # service, controller, routes
│       │   └── files/           # same layered structure
│       ├── utils/               # async-handler, ApiError
│       ├── app.ts               # Express app assembly
│       └── index.ts             # server bootstrap + graceful shutdown
├── docker-compose.yml      # local Postgres + MinIO (no AWS needed)
└── frontend/
    └── src/
        ├── app/                 # pages: /, /login, /register, /dashboard, /share/[id]
        ├── components/          # RequireAuth, AuthForm, Dashboard, FileUpload
        └── lib/                 # typed API client, AuthProvider, shared types
```

### Modular backend

Every feature is a self-contained module so a module can be reasoned about and tested on
its own:

```
modules/
  auth/   auth.constants.ts   auth.interfaces.ts   auth.validation.ts
          auth.service.ts     auth.controller.ts   auth.routes.ts
  files/  file.constants.ts   file.interfaces.ts   file.validation.ts
          file.service.ts     file.controller.ts   file.routes.ts
```

- **constants** – domain constants (limits, expiry, policy)
- **interfaces** – DTOs / shared types for the module
- **validation** – zod schemas for request bodies, params, query
- **service** – business logic + data access (Prisma, S3)
- **controller** – thin HTTP adapters that call the service
- **routes** – wiring validation + auth middleware to controllers

## Features

- Register / login (bcrypt-hashed passwords, JWT issued on success, `GET /api/auth/me`)
- Upload files up to 100 MB via presigned S3 PUT with client-side progress tracking;
  files up to 5 GB via S3 multipart (chunked, resumable per-part presigned URLs)
- Personal dashboard: list, toggle **public/private**, copy share link, download, delete
- Public share page (`/share/[id]`) with a downloadable link for anyone
- Authorization: private files require the owner; public files are accessible to all
- Request validation (zod), centralized error handling, rate limiting on auth endpoints
- Helmet security headers, CORS allow-list, JWT secret & env config validated at boot

## Getting started

### Option A — fully local, no external accounts (recommended)

Spin up PostgreSQL + MinIO (an S3-compatible object store) with Docker, then run the
backend and frontend with npm:

```bash
# 1. Infrastructure (Postgres on :5434, MinIO on :9000)
docker compose up -d --wait

# 2. Backend
cd backend
cp .env.example .env        # defaults already point at the local stack
npm install
npx prisma migrate deploy   # apply migrations to the local Postgres
npm run seed                # creates demo@example.com / password123
npm run dev                 # http://localhost:4000

# 3. Frontend
cd ../frontend
npm install
npm run dev                 # http://localhost:3000
```

MinIO console: http://localhost:9001 (`minioadmin` / `minioadmin`). MinIO answers browser
CORS preflight natively, so browser uploads work with no extra config.

> **Demo account:** `demo@example.com` / `password123` (created by `npm run seed`,
> idempotent). The login page has a one-click **"Try the demo account"** button.

### Option B — cloud S3 without AWS (Supabase Storage)

Supabase Storage exposes a drop-in **S3-compatible API**, so if you already have a Supabase
project you can point the app at it with a couple of env values — no AWS needed:

```bash
# Enable Storage → create a bucket → Settings → Storage → S3 Access Keys
S3_ENDPOINT=https://<PROJECT_REF>.supabase.co/storage/v1/s3
AWS_FORCE_PATH_STYLE=true
AWS_REGION=<any-region>
AWS_S3_BUCKET_NAME=<your-bucket>
AWS_ACCESS_KEY_ID=<s3-access-key>
AWS_SECRET_ACCESS_KEY=<s3-secret>
```

### Option C — real AWS S3

Leave `S3_ENDPOINT` empty and `AWS_FORCE_PATH_STYLE=false`, provide AWS credentials and a
bucket, and the SDK uses AWS directly.

Required env vars (see `backend/.env.example`):

| Variable                 | Description                                        |
| ------------------------ | -------------------------------------------------- |
| `DATABASE_URL`           | PostgreSQL connection string                       |
| `JWT_SECRET`             | Secret used to sign JWTs (≥16 chars)               |
| `S3_ENDPOINT`            | S3-compatible endpoint; **empty = real AWS S3**    |
| `AWS_FORCE_PATH_STYLE`   | `true` for MinIO / Supabase, `false` for AWS       |
| `AWS_REGION`             | Bucket region                                      |
| `AWS_S3_BUCKET_NAME`     | Bucket for file objects                            |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Provider credentials     |
| `FRONTEND_ORIGIN`        | Comma-separated allowed CORS origins               |

> **CORS note:** MinIO answers preflight automatically. On AWS you must configure the
> bucket to allow cross-origin `PUT` from the frontend origin and expose `ETag`. On
> Supabase Storage, CORS is controlled from the Storage settings.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:3000
```

The API base URL defaults to `http://localhost:4000/api`; override with
`NEXT_PUBLIC_API_URL` if needed.

## API reference

### Auth (`/api/auth`)

| Method | Path        | Auth | Body / Query                     | Description                                        |
| ------ | ----------- | ---- | -------------------------------- | -------------------------------------------------- |
| POST   | `/register` | No   | `{ email, password }`            | Create account → `{ token, refreshToken, user }`   |
| POST   | `/login`    | No   | `{ email, password }`            | Log in → `{ token, refreshToken, user }`           |
| POST   | `/refresh`  | No   | `{ refreshToken }`               | Rotate refresh token → `{ token, refreshToken }`   |
| POST   | `/logout`   | No   | `{ refreshToken }`               | Revoke the presented refresh token (204)           |
| POST   | `/logout-all` | Yes | –                               | Revoke all refresh tokens for the user (204)       |
| GET    | `/me`       | Yes  | –                               | Current user                                      |

`token` is a short-lived JWT access token (15 min); `refreshToken` is an opaque,
server-revokable token stored **hashed** (SHA-256) in the DB. Every refresh **rotates**
the refresh token; presenting an already-rotated token triggers reuse detection and
revokes the entire token family.

### Files (`/api/files`)

| Method | Path                   | Auth | Body                        | Description                                   |
| ------ | ---------------------- | ---- | --------------------------- | --------------------------------------------- |
| POST   | `/upload-url`          | Yes  | `{ fileName, fileType, fileSize }` | Presigned S3 PUT URL (≤100 MB, `fileType` allow-listed) |
| POST   | `/multipart/start`     | Yes  | `{ fileName, fileType, fileSize }` | Begin multipart upload (>100 MB, ≤5 GB); returns `{ uploadId, s3Key, partSize, partCount }` |
| POST   | `/multipart/part-url`  | Yes  | `{ uploadId, s3Key, partNumber }` | Presigned `UploadPart` URL for one part (resumable: re-request on failure) |
| POST   | `/multipart/complete`  | Yes  | `{ uploadId, s3Key, parts: [{ PartNumber, ETag }] }` | Complete upload + register metadata (HEAD-verified size, atomic quota) |
| POST   | `/multipart/abort`     | Yes  | `{ uploadId, s3Key }` | Abort upload and mark the record |
| POST   | `/`                    | Yes  | `{ fileName, s3Key, fileSize, mimeType }` | Register metadata after upload (HEAD-verified size + etag) |
| GET    | `/`                    | Yes  | –                           | List own files (`?limit` 1–50, `?cursor`; returns `{ files, nextCursor }`) |
| PATCH  | `/:id`                 | Yes  | `{ visibility: PUBLIC\|PRIVATE }` | Toggle visibility (owner only)       |
| DELETE | `/:id`                 | Yes  | –                           | Delete object + metadata (owner only)         |
| GET    | `/:id/download`        | Yes  | –                           | Presigned GET URL (owner, or anyone if public)|
| GET    | `/:id/share`           | No   | –                           | Public share link (403 if private)            |

Each user has a storage quota (`storageUsed` / `storageLimit`, default **1 GiB**, configurable
via `DEFAULT_STORAGE_LIMIT_BYTES`). Requests that would exceed the quota are rejected with
**413** — both when requesting an upload URL and, atomically, when registering metadata.
`GET /api/auth/me` exposes the current usage and limit.

Uploads of **> 100 MB** use the S3 multipart API (8 MB parts): the client asks for a presigned
URL per part and PUTs each chunk directly to S3, then completes the upload. Because a
multipart object's ETag (`…-N`) is not the content MD5, `checksum` is left `null` for these
files. The `reconcile` job aborts multipart uploads left incomplete for over 24 h.

## Security notes

- Passwords hashed with bcrypt (10 rounds); short-lived JWT access tokens (15 min) with a
  30-day revocable refresh token.
- File metadata keys are namespaced per owner (`<userId>/<uuid>-<name>`); registering
  metadata for a key you do not own is rejected.
- The public share endpoint returns a **signed, expiring URL** (5 min) — the S3 object
  itself stays private; access is enforced at the API layer, not by making the bucket public.
- **Session revocation:** the access JWT embeds `tokenVersion`; `POST /logout-all` bumps it,
  so previously issued access tokens stop working immediately (not just refresh tokens).
- Upload content types are restricted to a configurable **allow-list**
  (`ALLOWED_CONTENT_TYPES`), so the bucket can't be abused as a content host.
- Metadata registration is **HEAD-verified** against S3: the object must already exist and
  its actual size must match — catching truncated/fake uploads. The object's ETag (content
  MD5 for single-part uploads) is stored on the file row as `etag`/`checksum`.
- Auth endpoints are rate-limited; JSON body parsing is capped; Helmet + CORS allow-list
  applied globally.
