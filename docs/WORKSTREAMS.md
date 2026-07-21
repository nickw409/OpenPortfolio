# Workstreams

Living document tracking the major workstreams for OpenPortfolio v1.0. See [README.md](README.md) for product mission and engineering principles.

Status legend:
- **Complete** — done and meets its v1.0 scope
- **In progress** — work has started; specific remaining items listed
- **Not started** — nothing meaningful built yet

---

## 1. Database foundation and money types

**Status: Complete.**

SQLite (WAL mode) + Drizzle ORM as the persistence layer. Establishes the financial-integrity invariants that the rest of the codebase depends on. Without this, no other workstream can land cleanly.

Landed:
- [x] Drizzle setup with SQLite driver, WAL mode enabled at connection open
- [x] `Money` integer-cents type with branded TypeScript primitive — `type Money = number & { __brand: 'money' }` — and a small library of operations (add, subtract, multiply by ratio, divide returning ratio, format) that refuse to mix `Money` with `number`
- [x] Lint rule or unit test that fails if `number` arithmetic is performed on values typed as `Money`
- [x] Schema migration system with versioned migration files in `migrations/` (root)
- [x] Soft-delete convention: every table that holds user data includes `created_at`, `updated_at`, `deleted_at` (nullable) timestamps; all standard query helpers filter `deleted_at IS NULL` by default with explicit opt-in for inclusion
- [x] Backup / export utility: dump the SQLite file to a user-chosen location, with a checksum
- [x] Initial schema: 10 tables (`accounts`, `securities`, `transactions`, `price_history`, `cpi_data`, `dashboard_layouts`, `tile_configs`, `audit_log`, plus `tags` and `transaction_tags`) and `positions` as a derived view — see [specs/2026-05-15-initial-schema-design.md](specs/2026-05-15-initial-schema-design.md) for the table-list rationale

Deferred to dependent workstreams:
- Runtime migration check on app start — `runMigrations()` is built; wiring it into the Hono boot moves to Workstream 2.
- Database file location via Electron's `app.getPath('userData')` — env var `OPENPORTFOLIO_DB_PATH` covers dev; Electron integration moves to Workstream 11.

---

## 2. Backend API (Hono)

**Status: Complete.** Backend skeleton, boot orchestration, error envelope, structured logging, request/response middleware, health, and shutdown all landed against spec T1–T6 ([specs/2026-05-18-backend-api-design.md](specs/2026-05-18-backend-api-design.md)). Per-feature route groups land with the consuming workstreams (W3/W5/W7); file-sink rotation and dev CORS land with W11 and W4 respectively — these are spec-deferred, not WS2 work.

Landed:
- [x] Hono app skeleton with single-process Node entry point ([src/backend/index.ts](../src/backend/index.ts)); loopback-only on `127.0.0.1` with configurable port (T1)
- [x] Error-handling middleware: namespaced `{ code, message, context }` envelope ([src/shared/errors.ts](../src/shared/errors.ts), [src/backend/lib/error-handler.ts](../src/backend/lib/error-handler.ts)) (T2)
- [x] Shared Zod schema directory (`src/shared/schemas/`) with `MoneySchema` / `NonNegativeMoneySchema` (integer-cents enforced at the boundary; floats fail validation) (T3)
- [x] Migration-on-boot orchestration: open DB → version check → pre-migration backup → migrate → ready ([src/backend/lib/boot.ts](../src/backend/lib/boot.ts)); health reports `migrating` during the window (T4)
- [x] Structured logging via `pino` with pretty transport in dev ([src/backend/lib/logger.ts](../src/backend/lib/logger.ts)); level gated by `OPENPORTFOLIO_LOG_LEVEL` (T5)
- [x] Health endpoint at `GET /api/v1/health` returning `{ status, version, db_version, uptime_ms }` ([src/backend/routes/health.ts](../src/backend/routes/health.ts)) (T6)
- [x] Graceful shutdown: SIGINT/SIGTERM sets draining flag, new requests get `503 service.shutting_down`, in-flight requests drained up to 10s, SQLite closed cleanly ([src/backend/lib/shutdown.ts](../src/backend/lib/shutdown.ts)) (T6)
- [x] Transport decision resolved: HTTP on `127.0.0.1` ephemeral port (T1 §A)
- [x] Request/response logging middleware ([src/backend/lib/request-logger.ts](../src/backend/lib/request-logger.ts)): info-level per-request line, debug-level body capture, `/health` skip, mounted before `bootGate` so 503 paths log (T5)

Deferred to dependent workstreams (spec-aligned, not WS2 backlog):
- Per-feature route groups (`/accounts`, `/transactions`, `/positions`, `/returns`) — land alongside W3/W5/W7 as their UIs need them
- File-sink log rotation (`pino-roll` to `<userData>/logs/`) — needs Electron's `userData` (W11)
- Dev-mode CORS allowlist for the Vite dev origin — wired with W4 frontend bootstrap
- Optional loopback auth token — deferred to W11 review per spec open questions

---

## 3. Financial calculation engine

**Status: Complete.** Slice 1 (lots, basis, realized/unrealized, dividends) and slice 2 (TWR, MWR/IRR, drawdown, real returns net of CPI, allocation) both landed. Two checklist items are deliberately out of engine scope: the `regen-financial-fixtures.ts` typing helper (F7, not built — fixtures are hand-authored) and CI coverage enforcement (lands with W12).

The core business logic. Pure functions over `Money` values; no side effects, no I/O, no AI involvement. This is the audited deterministic code that AI features will call into. Engine lives at [src/backend/financial/](../src/backend/financial/); specs in [specs/2026-05-18-financial-engine-slice-1.md](specs/2026-05-18-financial-engine-slice-1.md) and [specs/2026-05-19-financial-engine-slice-2.md](specs/2026-05-19-financial-engine-slice-2.md).

Landed (slice 1):
- [x] Pure-function API surface over typed records, no DB/I/O dependencies (F1) — five top-level functions: `computeLots`, `computePosition`, `computePortfolio`, `computeRealizedGainsLoss`, `computeIncomeStream`
- [x] Position tracking from transaction history with on-demand lot reconstruction — no materialized lot table (F2)
- [x] Cost basis methods: FIFO (default), LIFO, specific-lot — `accounts.cost_basis_method` column added (migration `0001_boring_warbird.sql`) with per-call override accepting `LotSelectionMap` (F4, F6)
- [x] Split handling: `split` transactions interpret `quantity` as ratio; engine applies to prior lots' shares and per-share basis
- [x] `positions` SQL view dropped — engine is the single source of truth for holdings (F3)
- [x] Realized vs unrealized gain/loss via `computeRealizedGainsLoss` over the closed-lot stream
- [x] Dividend / interest / fee tracking and TTM yield via `computeIncomeStream` (caller injects current market value)
- [x] Typed `FinancialError` with stable codes (`unsupported.corporate_action`, `unsupported.mixed_currency`, sell-exceeds-holdings, etc.); no silent failures
- [x] Quantity precision: float `quantity` kept; engine never round-trips through float dollars; round-half-to-even at Money conversions (F5)
- [x] Property-based test asserting cents-of-drift bound under random transaction histories ([lots.property.test.ts](../src/backend/financial/lots.property.test.ts))
- [x] Golden-dataset fixtures under [tests/fixtures/financial/](../tests/fixtures/financial/): `simple-buy-sell`, `split-mid-history`, `multi-account`, `dividend-stream`, `realized-loss`

Landed (slice 2, spec [specs/2026-05-19-financial-engine-slice-2.md](specs/2026-05-19-financial-engine-slice-2.md)):
- [x] Daily valuation-series spine (`computeValuationSeries`) — the choke point TWR/MWR/drawdown reduce over; carry-forward pricing with a staleness ceiling (F1, F5)
- [x] Time-weighted return (TWR) via daily geometric chaining of the TR index (`computeTimeWeightedReturn`)
- [x] Money-weighted return (MWR / IRR) — Newton-Raphson seeded by TWR with bisection fallback, typed failure taxonomy (`computeMoneyWeightedReturn`)
- [x] Drawdown calculation: max drawdown, current drawdown, peak/trough/recovery dates — nominal and CPI-real (`computeDrawdown`)
- [x] **Real returns net of CPI**: linear CPI interpolation, no extrapolation; deflates nominal to constant-dollar real (`computeRealReturn`, `cpiAt`). CPI series is caller-injected — loading it from the `cpi_data` table is W6
- [x] Allocation calculations: by asset class, by account, by security (partitions), and by custom tag (lot-stream attribution, weights can exceed 100%) (`computeAllocation`)
- [x] Golden-dataset fixtures with hand-computed values: `daily-twr-simple`, `cashflows-mid-period`, `drawdown-2008`, `real-returns-1979-1981`, `allocation-by-class`, `allocation-by-tag`, `pre-funding-days`
- [x] Property tests: TWR ≡ geometric chain, TWR scale-invariance, valuation-series invariants ([valuation.property.test.ts](../src/backend/financial/valuation.property.test.ts))

Deferred (not engine work):
- [ ] `scripts/regen-financial-fixtures.ts` typing-convenience regen helper (F7) — not built; fixtures are hand-authored
- [ ] Coverage thresholds enforced in CI (target: 95%+ on `src/backend/financial/`) — lands with W12 test infrastructure

---

## 4. Frontend foundation (React)

**Status: Not started.**

React 18 + TypeScript + Vite. Renders inside Electron in production, runs against the dev backend in development.

Remaining:
- [ ] Vite config with absolute-path imports (`@/components/...`)
- [ ] TypeScript strict mode; no `any` without justification
- [ ] State management: TanStack Query for server state, Zustand for client UI state (avoid mixing the two)
- [ ] Routing: TanStack Router or react-router; one or two top-level routes (Dashboard, Settings) is enough for v1.0
- [ ] Design system: shadcn/ui base components, Tailwind v4 for styling
- [ ] Theme: light and dark, default to system preference
- [ ] Layout primitives: app shell with sidebar, main content area, optional right-hand drawer for AI chat
- [ ] Error boundaries at the route level with user-readable fallback UI
- [ ] Loading states: skeleton screens where data is expected, not spinners
- [ ] Formatting library for `Money` display (locale-aware, configurable currency symbol, no float conversions in display layer)

---

## 5. Data ingestion

**Status: Not started.**

Manual transaction entry plus CSV import. Broker API integration is out of scope for v1.0 (see workstream 13 for out-of-scope items).

Remaining:
- [ ] Manual transaction entry form (buy, sell, dividend, fee, split, transfer, deposit, withdrawal)
- [ ] CSV import with column-mapping UI: user uploads, sees a preview, maps columns to canonical fields
- [ ] CSV format presets for common brokers (Fidelity, Schwab, Vanguard, IBKR) — best-effort, user can correct mappings before commit
- [ ] Duplicate detection: hash of (date, security, quantity, price, account) flagged before insert
- [ ] Validation rules: sells can't exceed current holdings; dates can't be in the future; quantities and prices positive
- [ ] Transaction edit and soft-delete with audit trail
- [ ] Bulk operations: select multiple, delete, re-tag
- [ ] Account management: create, rename, archive (soft delete); tax-treatment classification (taxable, tax-deferred, tax-free)

---

## 6. Price and CPI data

**Status: Not started.**

Historical and current price data for valuing positions, plus CPI series for real-return calculations. User-configured provider; no provider is enabled by default.

Remaining:
- [ ] Provider abstraction: `PriceProvider` interface with `getQuote(symbol)`, `getHistory(symbol, range)`
- [ ] At least one provider implementation: Yahoo Finance scraping (free, fragile) or a paid provider with a user-supplied API key (Polygon, Alpha Vantage, Tiingo)
- [ ] Caching layer in `price_history` table; respect provider rate limits
- [ ] CPI series loader: download from BLS public data and store in `cpi_data`; refresh monthly
- [ ] Price-staleness detection: warn the user when prices are more than N days old
- [ ] Manual price entry as a fallback for illiquid or private holdings
- [ ] Graceful degradation when no provider is configured: positions still display at cost basis with a clear "no live prices configured" indicator

---

## 7. Tile-based dashboard

**Status: Not started.**

Configurable dashboard where users arrange information tiles. Built on dnd-kit for accessible drag-and-drop.

Remaining:
- [ ] Tile registry: each tile type registered with metadata (name, description, default size, allowed sizes, config schema)
- [ ] Tile components: positions table, allocation chart, returns timeline, drawdown summary, individual position card, dividend calendar, transaction feed, real-vs-nominal returns comparison, CPI overlay
- [ ] Layout state persisted in `dashboard_layouts` table; tile configs in `tile_configs`
- [ ] dnd-kit integration for rearrangement; resize handles for size changes (within tile's allowed sizes)
- [ ] Tile-level configuration UI: each tile has a settings drawer (e.g., real vs nominal toggle, date range, accounts to include)
- [ ] Add-tile flyout listing available tile types with previews
- [ ] Reset-to-default button
- [ ] Multiple named layouts (e.g., "Overview", "Tax Planning", "Deep Dive") with quick switcher
- [ ] Keyboard navigation for accessibility (dnd-kit supports this; needs deliberate wiring)

---

## 8. AI guardrails framework

**Status: Not started.**

The system that enforces no-buy/sell-recs, bear-cases-required, and sources-required behavior. Lives below the Ollama and MCP workstreams and is reused by both.

Remaining:
- [ ] Versioned system prompts in `src/prompts/`; each prompt file is a TS module exporting a versioned constant (e.g., `POSITION_ANALYSIS_PROMPT_V3`)
- [ ] Prompt registry: maps prompt names to current versions; old versions kept for audit
- [ ] Output validator: structural check on AI responses that ensures any analysis output includes a `counter_arguments` field and a `sources` field; reject and retry if missing
- [ ] Recommendation filter: post-processing pass on AI output that flags any text matching buy/sell-recommendation patterns; rejects the response and asks the model to retry with the guardrail re-emphasized
- [ ] Citation linker: AI responses cite data records by ID; the citation linker resolves IDs to UI-clickable links so users can verify the underlying data
- [ ] Audit log: every AI interaction stored locally with prompt version, input, output, validation results
- [ ] Prompt-engineering test suite: golden inputs paired with expected behavioral properties (e.g., "given a 30% drawdown question, output must mention recovery uncertainty"); regression suite catches prompt drift

---

## 9. Ollama integration

**Status: Not started.**

Local AI inference. No cloud calls. Ollama is the only AI backend supported in v1.0.

Remaining:
- [ ] Ollama client wrapper: connection check, model listing, model pull progress, generation streaming
- [ ] Model lifecycle: warm/cold management, `keep_alive` tuning to balance memory vs latency
- [ ] Recommended models list with descriptions (e.g., Llama 3.1 8B for general queries, larger models for users with the hardware)
- [ ] First-run flow: if Ollama isn't installed, show install instructions; if it is but no suitable model is pulled, offer to pull one
- [ ] Generation interface: takes a prompt name + variables from the prompt registry, returns a validated response via the guardrails framework
- [ ] Streaming responses to the UI so the user sees tokens as they generate
- [ ] Token usage logging (local only, for the user's own visibility)
- [ ] Graceful degradation: if Ollama is unreachable mid-session, surface the error clearly and disable AI features until reconnected; never silently retry forever

---

## 10. MCP server

**Status: Not started.**

Exposes read-only portfolio data to Claude Desktop and other MCP-compatible clients. Runs as a separate process, shares SQLite via WAL mode.

Remaining:
- [ ] MCP server process bootstrap, separate `package.json` entry point
- [ ] Read-only DB connection: SQLite opened in `mode=ro`, not just guarded at the query layer
- [ ] Tool definitions:
  - [ ] `list_accounts`
  - [ ] `list_positions(account_id?, as_of?)`
  - [ ] `get_position_history(symbol, range)`
  - [ ] `list_transactions(filters)`
  - [ ] `get_returns(account_id?, range?, real_or_nominal?)`
  - [ ] `get_drawdowns(account_id?, range?)`
  - [ ] `get_allocation(account_id?, dimension)`
- [ ] Tool descriptions that emphasize the model-vs-code split: tools return data, the AI client explains
- [ ] Claude Desktop config snippet documented in `docs/mcp-setup.md`
- [ ] Logging: every MCP query logged locally for the user's visibility
- [ ] Rate limit: prevent runaway loops from a misbehaving client (configurable max queries per minute)

---

## 11. Electron shell

**Status: Not started.**

Application packaging and OS integration. Wraps the React frontend and Hono backend into a single distributable app.

Remaining:
- [ ] Electron main process bootstrap with single-window management
- [ ] Backend lifecycle: spawn Hono process on app start, monitor health, restart on crash with backoff
- [ ] MCP server lifecycle: same pattern as the backend; user-toggleable in settings
- [ ] IPC layer between renderer and main process for OS-level operations (open file, save file, show in folder)
- [ ] Application menus (macOS, Windows, Linux conventions respected)
- [ ] Keyboard shortcuts for common actions
- [ ] Single-instance enforcement: launching a second copy focuses the existing window
- [ ] Data directory selection on first launch; default to OS conventions
- [ ] Auto-update infrastructure (deferred to workstream 13 if not feasible in v1.0)
- [ ] Window state persistence (size, position, maximized state)
- [ ] System tray integration (optional; macOS menu bar, Windows tray)

---

## 12. Test infrastructure

**Status: Not started.**

Coverage tooling, test patterns, and the discipline that makes the coverage targets enforceable.

Remaining:
- [ ] Vitest configured for backend, shared, and frontend test runs
- [ ] Coverage reporting via v8 coverage; thresholds enforced in CI: 95% on `src/backend/financial/`, 90% on `src/shared/`, 80% on `src/backend/routes/` and `src/backend/services/`
- [ ] Playwright for end-to-end tests that exercise the full Electron app
- [ ] Test database fixtures: known portfolio data with hand-computed expected values
- [ ] Golden test pattern for financial calculations: input portfolio + expected outputs in JSON fixtures, regenerable by a script
- [ ] Property-based testing setup with fast-check for calculation invariants
- [ ] Mock provider for AI tests: deterministic responses without hitting Ollama, used in the guardrails-framework test suite
- [ ] CI runs against the SQLite file format produced by the migration system; schema drift is a test failure

---

## 13. Packaging and distribution

**Status: Not started.**

Final-mile work to ship a downloadable application.

Remaining:
- [ ] electron-builder configured for macOS (universal binary), Windows (x64), Linux (AppImage, deb)
- [ ] Code signing: Apple Developer ID for macOS, EV certificate for Windows
- [ ] macOS notarization
- [ ] Auto-update channel: electron-updater pointed at GitHub Releases (deferred if too much scope)
- [ ] Release checklist in `docs/release-checklist.md`
- [ ] First-run experience: brief onboarding explaining the philosophy, data location, AI features being opt-in
- [ ] Public repo hygiene: no secrets, no hardcoded local paths, license headers
- [ ] Reproducible builds where feasible

---

## Cross-cutting invariants

These rules hold across every workstream. Workstream-level work that violates them gets rejected at review, regardless of how well-engineered it is.

### Financial integrity
- **Money is integer cents.** No floats. The type system enforces this where possible; review enforces it everywhere else.
- **Soft delete only.** Deleted records are marked, not removed.
- **Drizzle migrations only.** No hand-rolled `ALTER TABLE`.
- **Real returns are net of inflation.** Nominal is computed but not the default display.

### AI behavior
- **No buy/sell recommendations.** Not at the LLM level, not at the UI level, not in tooltips or error messages.
- **Bear cases required.** Any AI analysis includes counter-arguments.
- **Sources required.** AI responses cite the data they used.
- **System prompts are versioned.** Inline prompt strings in feature code are a code smell.

### Privacy
- **No telemetry.** Not error reporting, not analytics, not crash logs sent anywhere off-device.
- **No outbound network calls** except to explicitly user-configured services (price providers, BLS for CPI, Ollama on localhost).

### Code quality
- **Coverage targets are not optional.** 95% on financial calculations, 90% on shared utilities, 80% on services and routes.
- **TypeScript strict mode.** No unjustified `any`.
- **No silent failures.** Empty `catch` is a code smell.

---

## Cross-cutting risks under active management

- **AI guardrails effectiveness.** The whole product thesis depends on AI features actually behaving as designed. Prompt engineering can drift; LLMs can route around guardrails. Mitigation: structural enforcement (output validators, citation linking, recommendation-pattern filters) in addition to prompt-level instructions. Golden-prompt regression suite catches drift.
- **Price-data fragility.** Free price sources scrape and break; paid sources require user-supplied API keys most casual users won't have. v1.0 ships with graceful degradation (cost-basis display) and clear guidance for users on adding a provider.
- **Electron + multi-process complexity.** Three processes (Electron main, Hono backend, MCP server) sharing one SQLite file with WAL is the right architecture but has more moving parts than a typical desktop app. Mitigation: health checks, structured logging, single-instance enforcement, clear lifecycle management in the Electron shell workstream.
- **Coverage targets vs velocity.** 95% on financial code is high. It is also non-negotiable for code that touches money. Velocity loss is the deliberate cost of trustworthy calculations.
- **Scope discipline on the dashboard.** Tile systems balloon. v1.0 ships with the tile types listed in workstream 7 and nothing else; user-defined custom tiles are explicitly out of scope.

---

## Out of scope for v1.0

These are deliberate non-goals, not "later." If demand emerges they get reconsidered, but they do not land in v1.0 under any circumstance:

- Buy/sell recommendations (this is permanent, not deferred)
- Cloud sync of any kind
- Multi-user features
- Tax filing or generation of tax documents (data export for tax software is fine; tax claims from OpenPortfolio are not)
- Real-time tick data (end-of-day pricing is the design target)
- Broker API integration for automatic transaction import
- Mobile apps
- Web-hosted OpenPortfolio
- Crypto wallet integration (transaction-level entry is fine; on-chain integration is not)
- Social features (sharing, leaderboards, public portfolios)