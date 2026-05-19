# Backend API (Hono) — design spec

**Status:** Approved 2026-05-18
**Date:** 2026-05-18
**Workstream:** [docs/WORKSTREAMS.md](../WORKSTREAMS.md) §2 Backend API (Hono)
**Depends on:** [Initial schema](2026-05-15-initial-schema-design.md) (routes are the only writers to the schema)

## Context

WORKSTREAMS §2 names the Hono backend as the only writer to SQLite, talking to the Electron renderer over IPC in production and HTTP in development. It enumerates the route groups (`/accounts`, `/transactions`, `/positions`, `/returns`), validation (Zod at every boundary), error envelope shape, debug logging, a health endpoint, graceful shutdown, and a still-open decision on transport.

This spec resolves the cross-cutting forks that shape every route handler — transport, error envelope, schema sharing, migration-on-boot, logging — before the first route lands. Per-route shape (request/response Zod schemas, status codes, side effects) is normal implementation work and lives in the route files plus their tests.

Six forks: transport, error envelope, schema sharing, migration-on-boot, logging, health-and-shutdown.

---

## T1. Transport between Electron renderer and backend

WORKSTREAMS §2 flags this explicitly: HTTP-only vs Unix domain socket / named pipe.

- **A. HTTP on `127.0.0.1` with an ephemeral port** — Electron main spawns the backend, reads the chosen port from stdout, passes it to the renderer. Dev and prod use the same transport; `curl` works against the running app for debugging. Any local process can connect to the port; for a single-user local-first app this is a negligible widening of attack surface, since anything running as the user can already read the SQLite file.
- **B. Unix domain socket (POSIX) / named pipe (Windows)** — only processes with filesystem access to the socket path can connect; no TCP port at all. Marginally stricter isolation, but the renderer's `fetch` doesn't speak UDS directly — needs an IPC bridge in preload that forwards to the socket, which adds a layer to debug. Dev iteration with a browser tab pointed at the backend stops working.
- **C. HTTP in dev, UDS in prod** — most flexibility, but two transports to keep behaviorally identical. Subtle bugs (header casing, streaming back-pressure, error encoding) hide in the seam and only surface in packaged builds.

**Recommendation: A.** The security gain of UDS is small in a single-user-machine context where the attacker already has user-level access to the data file. The dev-ergonomics loss (no `curl`, no browser-tab dev) is concrete and immediate. Bind explicitly to `127.0.0.1` (not `0.0.0.0`); ephemeral port handed renderer-side via Electron IPC at startup so nothing is hardcoded. Revisit on evidence of a real threat model that UDS would mitigate.

Loopback binding is non-negotiable regardless of transport choice — never `0.0.0.0`.

---

## T2. Error envelope shape

WORKSTREAMS §2 calls for `{code, message, context}`. The fork is what `code` is and how it travels.

- **A. RFC 7807 Problem Details** — `application/problem+json` with `type` (URI), `title`, `status`, `detail`, `instance`. Standard, tooling exists, but the `type` URI is dead weight for a local app and the spec leans toward human-readable strings where we want machine-readable codes.
- **B. Custom envelope with namespaced string codes** — `{ code: 'validation.missing_field', message: 'transaction_date is required', context: { field: 'transaction_date' } }`. HTTP status set appropriately (4xx for client errors, 5xx for server faults), code is the canonical handle that the UI switches on.
- **C. Plain HTTP status + free-form body** — minimal, but loses structured handling on the client.

**Recommendation: B.** The namespaced-code convention (`domain.sell_exceeds_holdings`, `validation.invalid_money`, `not_found.account`) gives the frontend a stable, exhaustive set to switch on without parsing English. RFC 7807 is the right answer for a public API; this is an in-process API and the indirection costs more than it saves.

Codes are enumerated in `src/shared/errors.ts` as a const-as-union; the error class carries the code, HTTP status, and an optional `context` record. A single Hono error-handling middleware serializes uncaught errors to this envelope and logs them with full stack at debug level. Never empty `catch` — every catch logs the original at minimum.

---

## T3. Schema sharing between backend and frontend

Zod is the chosen validator (WORKSTREAMS §2). Where the schemas live shapes what duplication we accept.

- **A. Schemas defined in backend route files, frontend re-declares its own types** — clean module boundaries, but the two sides drift and integration bugs hide until runtime.
- **B. Shared `src/shared/schemas/` directory, both sides import the same Zod schemas, `z.infer<>` is the source of TS types** — single source of truth for request/response shape; type drift becomes a compile error.
- **C. OpenAPI generation from Zod (`@hono/zod-openapi` or similar) + client codegen** — strongest contract, but introduces a build step and a generated-artifact tree to keep current.

**Recommendation: B.** Both sides live in the same repo, the same tsconfig path resolves `@shared/*`, and the cost of a shared schema module is one import. Codegen (C) is the right move when backend and frontend ship separately; that's not us. Money fields use the `Money` brand from the shared types, so a `z.number().brand<'money'>()` schema enforces integer-cents at the boundary.

`Money` validation in Zod: `z.number().int().brand<'money'>()` plus a `.refine()` for non-negative where appropriate. Float inputs fail validation at the route boundary — no silent rounding.

---

## T4. Migration check on app boot

WORKSTREAMS §1 deferred the runtime migration wiring to this workstream. `runMigrations()` exists.

- **A. Auto-apply pending migrations on every boot** — single-user local app, backup utility already exists, simplest possible UX. Risk: a migration that corrupts data runs before the user has a chance to back up.
- **B. Check version on boot, refuse to start if behind, require explicit user-triggered migrate from the UI** — safer, but the UI doesn't exist yet at boot time, so this means a CLI fallback or a special Electron pre-launch screen. Real cost in plumbing.
- **C. Auto-backup, then auto-apply** — best of both: every migration boot snapshots the DB file via the existing backup utility first, then applies. Restore path is a file copy.

**Recommendation: C.** The backup utility already produces a checksummed sidecar; reuse it as a pre-migration hook. Backups land in `<userData>/backups/pre-migration-<timestamp>.sqlite` with a retention cap (keep the last 10, say). If a migration fails, the most recent pre-migration backup is the rollback. Failure is loud: backend refuses to start, surfaces a clear error to Electron main, which shows a recovery dialog (deferred to workstream 11 for actual UI; backend just returns a structured error on the health endpoint).

The boot sequence: open DB → check version → if behind, backup → migrate → start serving. Health endpoint reports `migrating` state during this window so Electron can show progress.

---

## T5. Logging

WORKSTREAMS §2 calls for "request/response logging at debug level (local only, never sent off-device)."

- **A. Hono's built-in logger middleware + `console.log`** — zero deps, fine for v1.0, but unstructured strings are awkward to grep at scale.
- **B. `pino` with a pretty transport in dev and a file sink in prod** — structured JSON, fast, well-trodden, log files land in `<userData>/logs/` with rotation. Adds one runtime dep.
- **C. Custom thin wrapper around `console.*`** — control, but reinventing pino badly.

**Recommendation: B.** pino's overhead is small, the structured output is what we actually want when a user reports a bug ("send me your last log file"), and rotation is built in via `pino-roll`. Log levels: `debug` (request/response bodies, gated behind `OPENPORTFOLIO_LOG_LEVEL=debug`), `info` (route hits, lifecycle), `warn` (recoverable issues), `error` (uncaught + 5xx). Never logs secrets — the only secret in this app is the user-provided price-provider API key, which we redact in a serializer.

Privacy invariant from WORKSTREAMS: logs are local-only, never sent off-device. No log shipping, no remote sinks, no error-reporting SDK. The user can `tail` their own logs; we don't see them.

---

## T6. Health and graceful shutdown

WORKSTREAMS §2 calls for a health endpoint and graceful shutdown. Fewer real forks here; documenting the shape.

- **Health: `GET /api/v1/health`** returns `{ status: 'ok' | 'migrating' | 'degraded', version, db_version, uptime_ms }`. `degraded` is reserved for "DB unreachable" or similar; Electron main polls this to decide whether to show the renderer or a recovery screen.
- **Shutdown:** SIGINT/SIGTERM handler sets a draining flag; the request middleware short-circuits new requests with `503 service.shutting_down`; in-flight requests are awaited up to a timeout (10s); the SQLite connection is closed cleanly; process exits 0. If the drain timeout fires with requests still pending, log a warning and force-exit — better than hanging Electron.

Not really a fork — single sensible shape. Calling it out so the implementation doesn't drift.

---

## Open questions

- **Auth between renderer and backend.** A loopback HTTP port means any process on the machine can talk to the backend. v1.0 lean: no auth, document the assumption clearly. v1.x could add a per-launch loopback token (Electron generates a random token, passes it to the renderer via preload, backend requires it as a header) without a schema change. Flag for workstream 11 review when Electron lifecycle is wired.
- **Streaming.** Ollama generation streams tokens. Does the backend proxy that stream (so all AI calls go through one place for guardrails), or does the renderer hit Ollama directly? Lean: backend proxies, because the guardrails framework (workstream 8) needs to see the full output before it reaches the UI. Confirm in workstream 8/9.
- **CORS in dev.** When the renderer runs under Vite dev server on a different port, hits to the backend cross origins. Hono's CORS middleware allowlists the Vite dev origin in dev only; in prod, renderer is loaded via `file://` or `app://` and CORS doesn't apply. Flagging so dev setup isn't a surprise.

---

## Out of scope (deliberately)

- HTTPS — loopback only, no TLS needed
- Multi-user auth, sessions, cookies
- Remote access of any kind (matches WORKSTREAMS privacy invariant)
- OpenAPI / generated clients (T3 §C)
- Distributed tracing, metrics export (T5: local logs only)
- Hot reload of route handlers in dev (Vite handles renderer; backend restarts on file change via `tsx watch`)

---

## Decisions and rationale

Approved 2026-05-18.

- **T1 — HTTP on `127.0.0.1` ephemeral port (A) chosen.** UDS / named pipe (B) rejected: the security gain (excluding other local processes) is small when the threat model is already "anything running as the user can read the SQLite file directly," and the dev-ergonomics loss (no `curl`, no browser-tab debug, preload bridge complexity) is concrete and immediate. Hybrid HTTP-dev / UDS-prod (C) rejected: two transports to keep behaviorally identical is a bug-hiding seam. Loopback binding (`127.0.0.1`, never `0.0.0.0`) is non-negotiable; revisit on evidence of a real threat model UDS would mitigate.
- **T2 — Custom envelope with namespaced string codes (B) chosen.** RFC 7807 (A) rejected: `type` URI is dead weight for a local in-process API, and the spec leans human-readable where we want machine-readable. Plain status + free-form body (C) rejected: loses structured client handling. Codes enumerated in `src/shared/errors.ts` as const-as-union; single Hono error middleware serializes uncaught errors and logs them with stack at debug level. Empty `catch` is a code smell per WORKSTREAMS invariant.
- **T3 — Shared `src/shared/schemas/` directory (B) chosen.** Per-side duplication (A) rejected: drift hides until runtime. OpenAPI codegen (C) rejected: right move when backend/frontend ship separately, not when they share a tsconfig. `z.infer<>` is the source of TS types; `Money` validated as `z.number().int().brand<'money'>()` at the route boundary — float inputs fail validation, no silent rounding.
- **T4 — Auto-backup then auto-apply (C) chosen.** Plain auto-apply (A) rejected: leaves no rollback path. Require-explicit-migrate (B) rejected: needs UI plumbing that doesn't exist at boot time. Reuses the existing checksummed backup utility as a pre-migration hook; backups land in `<userData>/backups/pre-migration-<timestamp>.sqlite` with retention cap (last 10). Boot sequence: open DB → check version → if behind, backup → migrate → start serving. Health endpoint reports `migrating` during this window so the Electron shell (workstream 11) can show progress.
- **T5 — pino with file rotation (B) chosen.** Hono built-in + `console.log` (A) rejected: unstructured strings are awkward to grep when a user reports a bug. Custom wrapper (C) rejected: reinventing pino badly. Levels: `debug` (request/response bodies, gated by `OPENPORTFOLIO_LOG_LEVEL=debug`), `info` (lifecycle), `warn`, `error`. Price-provider API keys redacted in a serializer. Privacy invariant from WORKSTREAMS holds: logs local-only, no remote sinks, no error-reporting SDK.
- **T6 — Health and shutdown shape as documented.** `GET /api/v1/health` returns `{ status: 'ok' | 'migrating' | 'degraded', version, db_version, uptime_ms }`. SIGINT/SIGTERM sets draining flag; new requests get `503 service.shutting_down`; in-flight requests awaited up to 10s; SQLite closed cleanly; force-exit on drain timeout (warn-logged).

**Open questions remain open** — not blocked on this spec:
- Loopback auth token deferred to workstream 11 (Electron lifecycle) — v1.0 lean is no auth, document the assumption.
- Backend-proxies-Ollama-stream vs renderer-direct deferred to workstream 8/9 — lean is backend-proxies so guardrails see full output.
- Dev-mode CORS allowlist for Vite origin: implementation detail at first-route time.

Implementation deviations, if any, will be appended below.
