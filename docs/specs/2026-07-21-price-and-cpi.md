# Price and CPI data — design spec

**Status:** Proposed
**Date:** 2026-07-21
**Workstream:** [docs/WORKSTREAMS.md](../WORKSTREAMS.md) §6 Price and CPI data
**Depends on:** [Initial schema](2026-05-15-initial-schema-design.md), [Slice-2 financial spec](2026-05-19-financial-engine-slice-2.md)

## Context

Workstream 6 supplies the external market data the financial engine needs for valuation, returns, drawdown, and real-return calculations. Two independent data streams:

1. **Security prices** — daily closing prices per `security_id`, cached in `price_history`.
2. **CPI series** — monthly BLS CPI-U index values, cached in `cpi_data`.

The product principle is user-configured, local-first, no telemetry, graceful degradation. No provider is enabled by default; when none is configured the app still shows positions at cost basis with a clear indicator.

This spec pins down the provider abstraction, the caching contract, rate-limiting storage, the CPI loader, staleness rules, and the service/route shape that exposes this to the rest of the backend.

---

## P1. Provider abstraction

The provider is the boundary between OpenPortfolio and external price sources.

- **A. Class-based `PriceProvider` interface** with `getQuote(symbol)` and `getHistory(symbol, range)`. Concrete providers implement the interface; a registry maps a config object to a provider instance.
- **B. Function-per-provider** with no shared interface. Each provider exports its own functions; the caller switches on a string.
- **C. Generic adapter over a fetch-shaped client** — providers are just URL builders + response parsers; a single `fetchPrices(client)` function handles the rest.

**Decision: A.** An explicit interface makes unit testing straightforward (a mock provider is a one-object implementation), makes the registry typed, and prevents provider-specific leakage into the service layer.

Interface:

```ts
export interface PriceQuote {
  symbol: string;
  close_cents: Money;
  quote_date: Date; // EOD date in the provider's calendar; we treat as UTC midnight
  source: string;
}

export interface PriceHistoryRange {
  from: Date;
  to: Date;
}

export interface PriceProvider {
  readonly name: string;
  getQuote(symbol: string): Promise<PriceQuote>;
  getHistory(symbol: string, range: PriceHistoryRange): Promise<PriceQuote[]>;
}
```

`getQuote` is not a special endpoint; the implementation may call `getHistory` for a 1-day range and return the latest point. The caller (price service) caches every returned point.

---

## P2. Which providers ship in v1.0

- **A. Yahoo Finance scraping only** — free, no API key, fragile; clear degradation path.
- **B. Polygon.io only** — robust, requires user API key; free tier is generous.
- **C. Both Yahoo and Polygon** — user chooses in settings; Yahoo is the zero-config default (with warnings), Polygon is the robust opt-in.

**Decision: C.** Yahoo covers the "I just opened the app" case; Polygon covers users who want reliability. The abstraction from P1 means adding a third provider later is a new file + registry entry.

Provider registry:

```ts
export type PriceProviderKind = 'yahoo' | 'polygon';

export interface PriceProviderConfig {
  kind: PriceProviderKind;
  // Polygon only.
  apiKey?: string;
}

export function createPriceProvider(config: PriceProviderConfig): PriceProvider;
```

Yahoo provider: parses Yahoo Finance `chart/v8` JSON. No API key. Marks source as `'yahoo'`. Robust parsing with typed errors (`price.fetch_failed`, `price.unexpected_response`).

Polygon provider: uses `api.polygon.io/v2/aggs/ticker/{symbol}/range/1/day/{from}/{to}`. Requires API key. Marks source as `'polygon'`.

---

## P3. Rate limiting storage

The backend must not get users banned by providers. Rate limits differ by provider and by user tier.

- **A. In-memory minimum-interval guard** — store last-request timestamp per provider in a process variable; no schema changes.
- **B. Persistent `provider_requests` table** — tracks each outbound request (provider, endpoint, timestamp, symbol) and enforces daily/monthly caps. Survives restarts and is auditable.

**Decision: B.** Per user choice. This lets the UI show "42 of 5 Polygon requests used today" and supports auditability. The table is a cache/audit table, so it deliberately does not soft-delete.

Schema addition (`migrations/0002_price_and_cpi.sql`):

```sql
CREATE TABLE `provider_requests` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `provider` text NOT NULL,
  `endpoint` text NOT NULL,
  `requested_at` integer NOT NULL,
  `symbol` text,
  `success` integer NOT NULL DEFAULT 0
);
CREATE INDEX `provider_requests_provider_time_idx` ON `provider_requests` (`provider`, `requested_at`);
```

Rate-limit rules are hard-coded per provider in the provider module:

- Yahoo: conservative minimum interval of 2 seconds between requests; no daily cap because the source is unofficial.
- Polygon free: 5 requests/minute, daily cap not enforced by us (Polygon enforces it); we track usage for visibility.

A `RateLimiter` service uses the table to decide whether a request is allowed and writes a row on every attempt.

---

## P4. Caching layer

- **A. Cache everything the provider returns; no TTL** — `price_history` stores the point; the service decides whether to refetch based on staleness, not the cache entry's age.
- **B. TTL on cache rows** — add `expires_at` and evict. More complex; prices don't really expire, they just become stale relative to today.
- **C. Cache only the latest quote; always fetch history fresh** — wastes provider quota and bandwidth.

**Decision: A.** `price_history` is the source of truth for historical prices. Staleness is a UI/valuation concern ("last price is N days old"), not a cache-eviction policy. Upserts are used so repeated fetches are idempotent.

Service contract:

```ts
export interface PriceServiceDeps {
  db: Db;
  provider: PriceProvider | null;
  logger: Logger;
}

export class PriceService {
  getLatestPrice(securityId: number, opts?: { maxStalenessDays?: number }): Promise<PriceQuote | null>;
  getPriceHistory(securityId: number, range: PriceHistoryRange): Promise<PriceQuote[]>;
  refreshQuote(symbol: string, securityId: number): Promise<PriceQuote>;
  setManualPrice(securityId: number, date: Date, close_cents: Money): Promise<PriceQuote>;
}
```

- `getLatestPrice`: returns the newest cached point. If a provider is configured and the cached point is older than `maxStalenessDays` (default 7), it attempts a refresh; if the refresh fails, it returns the stale point with a `stale` flag.
- `getPriceHistory`: returns cached points covering the requested range. If gaps exist and a provider is configured, fills them. Manual prices always take precedence over provider prices for the same date.
- `refreshQuote`: always fetches from the provider (subject to rate limit) and upserts the result.
- `setManualPrice`: writes a row with `source='manual'`. Used for illiquid/private holdings and as an override.

CPI uses the same caching logic: `cpi_data` stores `(series_id, period_date, index_value, fetched_at)`. The loader fetches BLS public series `CUUR0000SA0` (CPI-U, seasonally adjusted, US city average) and upserts monthly points. It is the only CPI provider in v1.0.

---

## P5. BLS CPI loader

- **A. Fetch from BLS public API v2** — JSON endpoint; no key for small usage.
- **B. Download the BLS flat file** — bulk text file; more complex parsing.
- **C. Ship a bundled snapshot** — no outbound call; stale the moment it's shipped.

**Decision: A.** The BLS public API is simple enough and keeps the data current. URL: `https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0` (no API key required for small queries; optional registration key for larger ones).

Loader contract:

```ts
export interface CpiServiceDeps {
  db: Db;
  logger: Logger;
}

export class CpiService {
  refreshMonthly(seriesId?: string): Promise<CpiPoint[]>; // default 'CUUR0000SA0'
  getSeries(seriesId?: string, range?: DateRange): Promise<CpiSeries>;
  getLatestDate(seriesId?: string): Promise<Date | null>;
}
```

- `refreshMonthly`: fetches the last 10 years from BLS, parses year+month+value, upserts into `cpi_data`, returns the inserted/updated points.
- The loader runs on demand from a route; a future workstream (Electron/settings) can schedule it monthly.
- It does not extrapolate. The financial engine already throws `cpi.out_of_range` for out-of-range dates; the service simply surfaces the series coverage.

---

## P6. Staleness rules and graceful degradation

- **A. Hard error when prices are stale** — computation fails. Too aggressive; dashboards should still render.
- **B. Compute at cost basis with a warning flag** — the financial engine already throws `price.stale`; the service layer catches this and returns a degraded snapshot plus a `warnings` array. This is the product behavior WORKSTREAMS calls for.

**Decision: B.** The price service returns a result envelope:

```ts
export interface ValuationPrices {
  prices: PriceHistory;
  warnings: PriceWarning[];
  fullyPriced: boolean;
}

export interface PriceWarning {
  code: 'price.stale' | 'price.no_provider' | 'price.no_price';
  security_id: number;
  symbol?: string;
  message: string;
  context?: Record<string, unknown>;
}
```

When no provider is configured, the service returns an empty price map and one `price.no_provider` warning per held security. The dashboard tile shows cost basis and the warning text.

When a provider is configured but a symbol has no price and no manual override, the warning is `price.no_price`.

When the latest price is older than the configured staleness threshold, the warning is `price.stale`.

---

## P7. Route group shape

- **A. `/api/v1/prices` and `/api/v1/cpi` as separate route groups** — clean separation; matches the two tables.
- **B. `/api/v1/market-data` with sub-resources** — single group, less surface.

**Decision: A.** Two route groups keeps the API obvious and mirrors the two independent services.

`POST /api/v1/prices/refresh` — body `{ security_id: number }`; fetches latest quote and returns the cached point.
`GET /api/v1/prices/:security_id` — query `as_of` (ISO date); returns latest or historical cached point.
`GET /api/v1/prices/:security_id/history` — query `from`, `to`; returns price history.
`POST /api/v1/prices/manual` — body `{ security_id, date, close_cents }`; manual override.
`GET /api/v1/cpi` — query `from`, `to`, `series_id`; returns CPI series.
`POST /api/v1/cpi/refresh` — fetches from BLS and returns new/updated points.

Provider configuration is not yet exposed via route; it lands with the settings/frontend workstream. For now the service is constructed in `src/backend/index.ts` with a provider read from environment (`OPENPORTFOLIO_PRICE_PROVIDER`, `OPENPORTFOLIO_POLYGON_API_KEY`). If no env var is set, provider is `null`.

---

## P8. Money handling at the boundary

Provider responses come in as decimal dollars. The provider layer converts to `Money` (integer cents) using `ofDollars` before crossing into the service layer. The service layer stores and returns `Money`. The Zod boundary schemas use `MoneySchema` or `NonNegativeMoneySchema` as appropriate.

---

## P9. Testing strategy

- Unit tests for each provider with mocked `fetch` responses.
- Unit tests for the rate limiter using an in-memory DB.
- Unit tests for the price service covering cache hits, cache misses, stale quotes, manual overrides, and no-provider degradation.
- Unit tests for the CPI loader with mocked BLS responses.
- No live network calls in tests; all HTTP is injected via a `Fetcher` interface (global `fetch` in production, stub in tests).

Coverage target: the new modules live under `src/backend/services/` and `src/backend/routes/`, so they fall under the 80% service/route threshold in `vitest.config.ts`. The provider abstraction itself is deterministic enough that 90% is the practical target.

---

## Out of scope (deliberately)

- Real-time tick data (end-of-day is the design target).
- FX rates / multi-currency pricing.
- Dividend / split data from providers (handled by user-entered transactions in v1.0).
- Automatic scheduled jobs; routes are on-demand until the Electron workstream lands a scheduler.
- Provider configuration UI/routes (settings workstream).
- Benchmark indices (S&P 500 history) beyond CPI.

---

## Decisions and rationale

- **P1 — Class-based interface (A) chosen.** Function-per-provider (B) rejected: no typed boundary, hard to mock in tests. Generic adapter (C) rejected: too much indirection, harder to provider-specific error handling and rate-limit rules.
- **P2 — Both Yahoo and Polygon (C) chosen.** Yahoo-only (A) rejected: too fragile for users who need reliability. Polygon-only (B) rejected: requires every user to obtain an API key before seeing any live prices, contradicting the zero-config-first degradation story.
- **P3 — Persistent `provider_requests` table (B) chosen.** In-memory guard (A) rejected: loses usage visibility across restarts and prevents the UI from showing quota consumption.
- **P4 — Cache all provider rows, no TTL (A) chosen.** TTL (B) rejected: prices don't expire; staleness is a caller concern. Cache-only-latest (C) rejected: wastes quota and removes historical coverage.
- **P5 — BLS public API v2 (A) chosen.** Flat file (B) rejected: more parsing work, no freshness advantage. Bundled snapshot (C) rejected: stale at ship time, no outbound-call transparency.
- **P6 — Degraded valuation with warnings (B) chosen.** Hard errors (A) rejected: dashboards must render even without live prices; WORKSTREAMS explicitly calls for cost-basis fallback.
- **P7 — Separate `/api/v1/prices` and `/api/v1/cpi` route groups (A) chosen.** Single group (B) rejected: less obvious resource mapping, harder to document.
- **P8 — Provider converts to `Money` using `ofDollars` before service layer.** Keeps the integer-cents invariant at the boundary; service layer never parses floats.
