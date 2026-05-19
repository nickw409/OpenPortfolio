# Financial calculation engine — slice 2 (returns, drawdown, real returns, allocation)

**Status:** Drafted 2026-05-19
**Date:** 2026-05-19
**Workstream:** [docs/WORKSTREAMS.md](../WORKSTREAMS.md) §3 Financial calculation engine
**Depends on:** [Slice 1](2026-05-18-financial-engine-slice-1.md), [Initial schema](2026-05-15-initial-schema-design.md), [Money primitive](2026-05-15-money-primitive-design.md)

## Context

Slice 1 shipped the deterministic lots-at-time-T core: positions, cost basis (FIFO/LIFO/specific), splits, realized G/L, dividends. Slice 2 layers the *time-dimensioned* analytics on top: time-weighted return (TWR), money-weighted return (MWR/IRR), drawdown, real returns net of CPI, and allocation breakdowns.

Same constraints as slice 1: pure functions, zero I/O, zero Drizzle, plain typed arguments in, plain typed values out. Engine module imports zero DB code. Errors throw `RangeError`/`TypeError` for argument-shape problems and typed `FinancialError` with stable `code` for business-rule violations.

Two new shapes of input cross the boundary:

- A **price history** map (sparse daily) — the engine carries forward weekends/holidays/gaps and refuses to compute a market value beyond a configurable staleness limit.
- A **CPI series** (monthly BLS CPI-U) — the engine interpolates linearly between adjacent monthly points and refuses to extrapolate beyond the series.

Nine forks below: scope packaging, TWR algorithm, external-cashflow definition, calculation scope (portfolio vs per-account), the valuation-series primitive, CPI deflation strategy, drawdown basis (nominal vs real), allocation dimensions and the tag-allocation rule, and price-history input shape. Two implementation details that aren't really forks but warrant pinning down: the TR-index construction conventions and the MWR/IRR algorithm.

---

## F1. Slice packaging

WORKSTREAMS §3 enumerates five remaining capabilities for slice 2 (TWR, MWR, drawdown, real returns net of CPI, allocation). The question is whether they ship together or get sub-sliced.

- **A. Single spec, all five capabilities.** One review cycle, one implementation plan, one merge.
- **B. Sub-slice: returns + drawdown only.** Allocation as a separate follow-up. Smaller spec, less surface.
- **C. Sub-slice: time-series core only.** Just `computeValuationSeries` + TWR + MWR; drawdown and real-returns layer on later.
- **D. Allocation first.** Easiest piece (pure aggregation over slice-1 outputs); doesn't need price history.

**Decision: A.** All five in one spec. Returns, drawdown, and real returns all consume the same daily valuation series (F5), so splitting them across specs creates a coordination problem (the F5 primitive's shape is decided three times). Allocation is genuinely independent but small enough that bundling adds little weight. Single review, single plan.

---

## F2. TWR algorithm

TWR strips the effect of cashflow timing from raw period returns. Three standard algorithms differ in data requirements and accuracy.

- **A. True daily TWR.** Daily portfolio valuations; geometric chain of `(V_close − CF) / V_open − 1` per day. Most accurate. Requires daily price history for every security ever held (carry-forward fills weekends/holidays). Drawdown is a natural by-product of the same daily series.
- **B. Modified Dietz.** Single-period formula using start value + end value + weighted cashflows. Requires no intra-period prices. Inaccurate under large mid-period cashflows. Industry default decades ago; less common now.
- **C. Linked Modified Dietz.** Sub-period Modified Dietz chained at each cashflow date. Accuracy approaches daily TWR without requiring daily prices — only prices on cashflow dates.
- **D. Both daily TWR and Modified Dietz.** Caller picks. Larger API, more tests, more docs.

**Decision: A — true daily TWR.** Daily prices are the data shape W6 is going to produce anyway (broker EOD feeds, free scrapers, paid providers all return daily series). Daily TWR gives us drawdown for free (same series), and the carry-forward rule from F9 makes weekend/holiday gaps a non-issue. Modified Dietz's accuracy gap matters for institutional reporting (where cashflows can be tens of percent of AUM in a day); for retail portfolios it's noise, and the data-density saving is illusory once we want drawdown anyway.

---

## F3. External cashflow definition

TWR and MWR both partition transactions into "internal" (movement of assets/cash within the portfolio) and "external" (money entering or leaving the portfolio). The partition determines what the returns *mean*.

- **A. `deposit` and `withdrawal` only at portfolio scope.** Buys, sells, dividends, interest, fees are internal (cash sleeve modeled implicitly). `transfer_in` / `transfer_out` are internal at portfolio scope (the user is moving money between their own accounts; no flow leaves the portfolio).
- **B. `deposit`, `withdrawal`, `transfer_in`, `transfer_out` symmetrically.** Simpler rule. Distorts portfolio-wide TWR when transfers are between user-owned accounts unless we also pair-detect transfers.
- **C. Configurable per call.** Engine accepts a `cashflowKinds: TxType[]` option.

**Decision: A.** Matches the GIPS convention used by professional portfolio reporting. At *account* scope (F4) the engine additionally treats `transfer_in` / `transfer_out` as external — for one account, a transfer to another account is a withdrawal from its books. The scope parameter (F5) drives the cashflow set internally; callers don't pick the set, they pick the scope.

Implication for v1.0 cash modeling: a buy without a corresponding deposit is silently funded from an implicit "infinite cash" sleeve. A deposit without a corresponding buy raises portfolio market value (held as implicit cash, valued at face). Cash-as-an-asset is out of scope (slice 3 candidate). Users entering data should expect to record deposits explicitly for TWR to read correctly.

---

## F4. Calculation scopes

WORKSTREAMS calls for "TWR, MWR, drawdown" without specifying scope. The dashboard will plausibly want both whole-portfolio and per-account metrics.

- **A. Portfolio + per-account.** Both. Per-account treats transfer_in/out as cashflows; portfolio nets them.
- **B. Portfolio only.** Smallest surface. Per-account becomes a known follow-up.
- **C. Portfolio + per-account + per-security.** Per-security is conceptually messy: a single security has no external cashflows, so its "return" is just price appreciation + dividends — already what slice 1's `computePosition` reports. No new primitive needed.
- **D. Portfolio + per-account + per-tag.** Tag-grouped TWR. Requires defining cashflows for an arbitrary tag bucket. Defer post-v1.0.

**Decision: A.** Per-account is a meaningful question for any user with tax-advantaged + taxable accounts running different strategies. Per-security adds no new primitive (use `computePosition`). Per-tag adds a real design question; defer. The scope parameter is a discriminated union: `Scope = 'portfolio' | { account_id: number }`.

---

## F5. Valuation-series primitive

TWR, drawdown, and real-returns all need a daily series of `(market_value, external_cashflow, total_return_index)`. The question is whether to expose it.

- **A. Exported primitive: `computeValuationSeries`.** First-class function. TWR, drawdown, real-returns are reducers over it. Tested exhaustively at the bottom layer; upper layers are mechanical. Mirrors slice 1's `computeLots` choke-point pattern.
- **B. Internal helper.** Each function computes its own series. Risk: parallel implementations drift; redundant work when callers want multiple metrics on the same range.
- **C. Exported + memoized.** Cache keyed on `(txns hash, prices hash, range)`. Defer caching until profiling demands it.

**Decision: A.** Exported, no caching. The 250ms perf budget for a 100-security 10-year portfolio (all 6 outputs combined) is well within tolerance for an interactive dashboard tile; memoization is the optimization to skip until profiling says otherwise.

`ValuationSeries` shape:

```ts
type ValuationSeries = {
  points: ReadonlyArray<{
    date: Date,
    market_value_cents: Money,         // Σ open lots × carried-forward price
    cost_basis_cents: Money,           // Σ open lots' basis (context only)
    external_cashflow_cents: Money,    // signed: deposits +, withdrawals −
    tr_index: number,                  // total-return index, starts at 1.0
  }>,
  scope: Scope,
  range: DateRange,
};
```

---

## F6. CPI deflation

CPI-U is monthly; daily TWR is daily. The deflation strategy decides what "real return" charts look like.

- **A. Period-boundary deflation, linear interpolation.** Compute nominal for `[t0, t1]`; look up `cpi(t0)` and `cpi(t1)` by interpolating between adjacent monthly points; `real = (1+nominal)/(1+cpi_change) − 1`. Real *time series* (for charts) interpolates CPI to each day.
- **B. Step function (last-known CPI).** Each day uses the most recently released monthly CPI. Charts show stair-steps on release dates.
- **C. Don't bake CPI in; expose nominal only + a separate `computeRealReturn` helper.** Most decoupled; real-value charts harder to produce.

**Decision: A.** Linear interpolation is the standard treatment in academic and industry literature; the stair-steps in B are visually noisy without being more "correct" (we're not claiming to know intra-month CPI; we're showing a smoothed estimate). Strict boundary behavior: requested dates outside the supplied series throw `FinancialError('cpi.out_of_range')`. The engine never extrapolates — extrapolation is a forecast, and forecasts don't belong in audited calc code.

Operational consequence: BLS publishes CPI for month M around mid-month M+1, so "real returns through yesterday" usually has a 2–6 week tail gap. Callers asking for real returns must clamp `t_end` to the last CPI release date; the engine surfaces the gap as an error rather than guessing.

---

## F7. Drawdown basis

Drawdown is path-dependent; running it on a different series gives a different number, not just a different scale.

- **A. Nominal + real, both.** Engine produces a TR index (cashflow-neutral) and its CPI-deflated counterpart, returns peak/trough/recovery stats on both. Real drawdowns are deeper than nominal during high-inflation periods (1970s, 2022) — a distinction WORKSTREAMS explicitly calls out.
- **B. Nominal only.** Simpler; loses the "real returns are the default display" framing for the drawdown tile specifically.
- **C. Real only.** Strictest "real-first" interpretation, but disagrees with every published equity-market drawdown number users will compare against.

**Decision: A.** `computeDrawdown(series, cpi?)` returns `{ nominal: DrawdownStats, real: DrawdownStats | null }`. `real` is `null` when `cpi` is omitted, throws `cpi.out_of_range` when CPI doesn't cover the requested range. Each `DrawdownStats` reports `max_drawdown_pct`, peak/trough/recovery dates, current-drawdown stats from the most recent peak.

---

## F8. Allocation dimensions and tag-allocation rule

WORKSTREAMS calls for allocation "by asset class, by account, by security, by custom tag". Three of those are unambiguous (each position has one asset class, one account, one security). Tags are different: tags live on transactions, but allocation is a snapshot — a position built from multiple tagged buys has multiple tags.

- **A. asset_class, account, security; tag at lot level.** Each open lot inherits the tags of its opening buy. A position split across tagged buys reports allocation by lot, not by position.
- **B. asset_class, account, security only.** Skip tags in slice 2.
- **C. All four; tag at most-recent-buy.** Tag the position by its most recent opening buy. Loses information.
- **D. All four; "(untagged)" bucket for mixed positions.** Position has tags only if all underlying lots share them. Most lots end up untagged.

**Decision: A.** Tag-allocation operates on the lot stream from slice 1's `computeLots`. Each lot contributes its market value to every tag bucket its opening buy carries. A lot tagged `core,long-term` contributes its full value to both buckets; sum of tag-weight-percents can exceed 100% (tags are descriptive, not partitioning). Untagged lots aggregate into a single `"(untagged)"` bucket. For the other three dimensions, weights partition the portfolio and sum to exactly 100% (within rounding tolerance).

Lookup data is caller-supplied (consistent with F1 from slice 1 — no I/O in the engine):

- `dimension='asset_class'` needs `securities: Map<security_id, { asset_class }>`.
- `dimension='account'` needs `accounts: Map<account_id, { name, tax_treatment }>`.
- `dimension='security'` needs `securities: Map<security_id, { symbol }>` (engine falls back to `"security:<id>"` if symbol is null — securities can be private).
- `dimension='tag'` needs `lots: Lot[]` + `lotTags: Map<sourceTxId, string[]>`.

Missing entries throw `FinancialError('allocation.missing_security')` / `'.missing_account'`.

---

## F9. Price-history input shape

The contract between the engine and W6 (price-data workstream, not yet built). W6 will reify whatever shape we specify here.

- **A. Sparse daily map with carry-forward + staleness limit.** `PriceHistory = Map<security_id, Array<{ date, price_cents }>>`. Engine carries forward (forward-only — never backward) the last known price across weekends/holidays/gaps. If a security has no preceding price within `maxStalenessDays` (default 7) of a day it was held, throws `FinancialError('price.stale')`. Matches typical broker-feed reality.
- **B. Dense daily map, error on missing day.** Caller provides every calendar day. Strictest; pushes carry-forward to W6. W6 ends up doing the same carry-forward.
- **C. Trading-calendar aware (NYSE).** Engine knows the NYSE calendar; only computes valuation on trading days. Adds a calendar dependency; complicates multi-exchange securities.

**Decision: A.** Sparse + carry-forward + 7-day staleness. The "staleness" check is per-day-held, not per-call: if a position was held for a stretch where the security has no fresh price, *that stretch* fails, not the whole call. Configurable via `opts.maxStalenessDays`. The NYSE-calendar refinement (C) is post-v1.0; the engine's behavior on weekends (TR index flat, no spurious returns) is correct without it.

---

## TR-index construction

Not a fork — pinning down the conventions because they're the most subtle piece of slice 2 and the property tests need an unambiguous reference.

Definition, day-by-day, starting from `tr_index[0] = 1.0`:

```
For each day d after the first:
  V_open  = market_value[d−1]                       // yesterday's close
  CF_d    = external_cashflow_cents[d]              // signed: deposits +, withdrawals −
  V_close = market_value[d]                         // today's close

  // The day's investment-only return strips the cashflow:
  daily_return = (V_close − CF_d) / V_open − 1      // if V_open > 0
                 0                                  // if V_open == 0 (pre-funding)

  tr_index[d] = tr_index[d−1] × (1 + daily_return)
```

Conventions:

- **Cashflow timing.** Start-of-day. `V_open + CF_d` is the capital base producing `V_close`. Matches the GIPS start-of-day convention and the way brokers post deposits. (End-of-day alternative would compute `daily_return = V_close / (V_open + CF_d) − 1`.)
- **Empty days.** Weekends, holidays, no-price days carry forward yesterday's price. `market_value` changes only via share changes (buys/sells/splits on those days, rare but legal). TR index flat.
- **Pre-funding days.** `V_open == 0` → `tr_index` stays at 1.0. The first day with positive value sets the baseline.
- **Splits.** Handled by slice 1's `computeLots` walk: share count and per-share basis both adjust, so market value is continuous through the split. TR index sees zero discontinuity.
- **Cash dividends.** Slice 1 treats `dividend` as income, not a holding change — cash dividends do not enter `market_value` unless explicitly entered as a separate `buy` (the DRIP pattern documented in slice 1). Spec calls this out so users entering only `dividend` transactions know dividend income won't show up in TR / TWR.

Property tests:
- TWR equals geometric chain of daily returns to within 1e-9.
- Scale-invariance: doubling all cashflows and share quantities leaves TWR unchanged.

---

## MWR / IRR algorithm

Also not a real fork — pinning down behavior so implementation doesn't drift.

IRR solves:

```
0 = −V_start − Σ_i CF_i × (1+r)^(−t_i) + V_end × (1+r)^(−T)
```

where `t_i = (date_i − range.from) / 365.25` (so `r` is annualized) and cashflow signs are: deposits positive (outflow from wallet → portfolio), withdrawals negative.

Algorithm: Newton-Raphson with bisection fallback.

1. Initial guess: `r₀` = annualized TWR for the same range (computed from the same `ValuationSeries`).
2. Newton step: `r_{n+1} = r_n − NPV(r_n) / NPV'(r_n)`.
3. Tolerance: `|NPV(r)| < 1 cent` OR `|r_{n+1} − r_n| < 1e-10`.
4. If 100 Newton iterations don't converge, OR any iterate leaves `[−0.99, 10.0]`: fall back to bisection on the same interval.
5. If `NPV` doesn't change sign in `[−0.99, 10.0]`: throw `FinancialError('irr.no_solution')`.
6. If bisection exhausts its 100 iterations: throw `FinancialError('irr.no_convergence')`.

Edge cases:
- Single-period, no intermediate cashflows: collapses to `(V_end / V_start)^(1/years) − 1`. Newton converges in 2–3 iterations.
- Zero or negative starting value: throws `FinancialError('irr.bad_initial_state')`.
- Multiple sign changes in NPV (rare): bisection finds *a* root; we accept "first root in the interval" and document this. No `irr.multiple_roots` warning in v1.0.

`MwrResult.method` surfaces `'newton'` or `'bisection'` for debugging. `iterations` is the total across both phases.

---

## Public API surface

Six new top-level exports, mirroring slice 1's layered-primitives pattern.

```ts
// Choke point. Daily portfolio value, cashflows, and TR index over the range.
computeValuationSeries(
  txns: Tx[],
  prices: PriceHistory,
  range: DateRange,
  opts: { scope: Scope, maxStalenessDays?: number },
) → ValuationSeries

// TWR = (tr_index[last] / tr_index[first]) − 1. Annualized when range ≥ 1y.
computeTimeWeightedReturn(series: ValuationSeries) → {
  return_pct: number,
  annualized_pct: number | null,
  days: number,
}

// MWR / IRR via Newton + bisection.
computeMoneyWeightedReturn(series: ValuationSeries) → {
  irr_pct: number,
  iterations: number,
  method: 'newton' | 'bisection',
}

// Drawdown on TR index; nominal + real (if cpi supplied).
computeDrawdown(series: ValuationSeries, cpi?: CpiSeries) → {
  nominal: DrawdownStats,
  real: DrawdownStats | null,
}

// Stateless period-boundary helper.
computeRealReturn(
  nominal_pct: number,
  range: DateRange,
  cpi: CpiSeries,
) → { real_pct: number, cpi_change_pct: number }

// Snapshot aggregation; consumes a PortfolioSnapshot from slice 1.
computeAllocation(
  snapshot: PortfolioSnapshot,
  opts: AllocationOptions,
) → AllocationBreakdown
```

Types (`ValuationSeries`, `DrawdownStats`, `AllocationOptions`, `AllocationBreakdown`, `Scope`, `DateRange`, `PriceHistory`, `CpiSeries`) exported from `src/backend/financial/types.ts` alongside the slice 1 types.

---

## Errors

New `FinancialError` codes, all stable strings:

- `price.stale` — held security has no price within `maxStalenessDays` of a held day. Context: `{ security_id, last_price_date, requested_date, max_staleness_days }`.
- `cpi.out_of_range` — requested date is before first or after last CPI release. Context: `{ requested_date, cpi_range: { from, to } }`.
- `irr.bad_initial_state` — IRR requested with zero/negative starting value. Context: `{ scope, start_value_cents }`.
- `irr.no_solution` — no real IRR in `[−0.99, 10.0]`. Context: `{ cashflows, start_value_cents, end_value_cents }`.
- `irr.no_convergence` — Newton + bisection exhausted. Context: `{ last_estimate, last_npv, iterations }`.
- `allocation.missing_security` / `allocation.missing_account` — lookup map didn't have the key. Context: `{ id }`.
- `unsupported.mixed_currency` — reused from slice 1.

`RangeError` / `TypeError` continue to cover argument-shape validation (negative `maxStalenessDays`, `to < from`, missing required option for the chosen dimension).

---

## Golden fixtures and property tests

New fixtures under `tests/fixtures/financial/`:

- `daily-twr-simple` — buy day 1, hold 30 days flat, sell day 31 at +10%. Expected TWR = 10%, MWR ≈ 10%, drawdown 0.
- `cashflows-mid-period` — deposits day 10 and day 20, market moves +5% / −3% / +8%. Hand-computed daily TR index. TWR and MWR diverge.
- `drawdown-2008` — synthetic 18-month series with 40% peak-to-trough drop and partial recovery. Expected `max_drawdown_pct = −40%`, `recovery_date = null`.
- `real-returns-1979-1981` — high-inflation period. Nominal ≈ +14% annualized, CPI ≈ +13.3%, real ≈ +0.6%. Catches deflation sign errors.
- `allocation-by-class` — three securities across two asset classes. Weights partition to 100%.
- `allocation-by-tag` — two lots tagged `core`, one tagged `core,long-term`, one untagged. Sum of weights > 100% (validates the tag-attribution rule).
- `pre-funding-days` — empty account for 10 days, then a deposit. TR index stays at 1.0 through the empty stretch.

Property tests (fast-check):

- **TWR scale-invariance**: doubling all cashflows and share quantities leaves TWR unchanged.
- **TWR ≡ geometric chain**: `computeTimeWeightedReturn(series).return_pct` matches the geometric chain of daily returns to within 1e-9.
- **Drawdown bounds**: `max_drawdown_pct` is in `[−100, 0]` everywhere (percent units, consistent with the other `_pct` fields).
- **MWR ≈ TWR when flat-cashflow**: zero intermediate cashflows ⇒ MWR within 1e-6 of annualized TWR.
- **Allocation partition**: for `asset_class` / `account` / `security` dimensions, sum of `weight_pct` is `100 ± 0.01`.

Coverage target stays at 95% on `src/backend/financial/`; CI enforcement still lands with W12.

Advisory performance budget: 100-security × 10-year portfolio (≈3650 days) running all six outputs under 250ms on dev hardware. Not a CI gate; if implementation runs slower, profile before optimizing.

---

## Open questions

- **Risk metrics** (stdev of daily returns, Sharpe, Sortino, beta). Not in WORKSTREAMS §3. Slice 3 candidate.
- **Benchmark comparison.** Comparing portfolio TWR vs an index (S&P 500, 60/40 blend) requires benchmark-return infrastructure that doesn't exist. Slice 3 candidate.
- **Rolling returns** (1Y / 3Y / 5Y rolling-window TWR series). Mechanical extension of `computeTimeWeightedReturn` over sliding windows; defer until a dashboard tile spec calls for it.
- **Cash-position tracking.** Slice 2 ships with implicit cash sleeves (a buy without a deposit is silently funded; a deposit without a buy raises portfolio value as held cash). Cash-as-an-asset is a v1.x design.
- **DRIP UX.** Slice 1's "enter dividend + separate buy" pattern continues. If users find it tedious, a UI-side "reinvest" helper that creates the paired transactions is a frontend concern, not engine.

---

## Out of scope (slice 2, deliberately)

- Volatility / Sharpe / Sortino / beta (slice 3 candidate).
- Benchmark comparisons (slice 3 candidate).
- Rolling-window return series (deferred; mechanical to add later).
- Multi-currency portfolios (continues to throw `unsupported.mixed_currency` per slice 1).
- Wash sale (post-v1.0 per slice 1).
- Per-security TWR (use slice 1's `computePosition`; no new primitive).
- Per-tag TWR / MWR (tag-bucket returns require defining cashflows over arbitrary tag subsets; post-v1.0).
- Lot-level allocation by asset_class / account (redundant: lots inherit those directly).
- Memoization / caching for `computeValuationSeries` (profile before adding).
- NYSE / multi-exchange trading-calendar awareness (carry-forward handles weekends correctly without it).
- Cash-position tracking (v1.x).

---

## Decisions and rationale

Drafted 2026-05-19. Approval pending user review.

- **F1 — single spec, all five capabilities (A) chosen.** Sub-slicing (B, C, D) rejected: returns, drawdown, and real-returns share the F5 primitive, so splitting them creates a coordination problem; allocation is small enough to bundle.
- **F2 — true daily TWR (A) chosen.** Modified Dietz (B) rejected: data-density savings illusory once drawdown is in scope. Linked Modified Dietz (C) rejected: extra algorithm complexity for a retail use case where the accuracy delta is noise. Dual (D) rejected: two algorithms to test and document for negligible payoff.
- **F3 — `deposit`/`withdrawal` only at portfolio scope; `transfer_in`/`transfer_out` added at account scope (A) chosen.** Symmetric treatment (B) rejected: distorts portfolio TWR for inter-account transfers. Configurable (C) rejected: pushes a design decision onto callers; the scope parameter encodes the right answer.
- **F4 — portfolio + per-account (A) chosen.** Portfolio-only (B) rejected: per-account is a meaningful question for users with mixed tax-treatment accounts. Per-security (C) rejected: redundant with `computePosition`. Per-tag (D) rejected: requires a cashflow definition over arbitrary tag subsets; defer post-v1.0.
- **F5 — exported `computeValuationSeries` primitive (A) chosen.** Internal helper (B) rejected: parallel implementations drift; expensive when callers want multiple metrics. Memoized (C) rejected: optimization without profiling.
- **F6 — period-boundary deflation with linear CPI interpolation (A) chosen.** Step function (B) rejected: stair-step charts aren't more "correct," just noisier. Decoupled nominal-only (C) rejected: makes real-value charts harder to produce. Strict throw on out-of-range — engine never extrapolates.
- **F7 — drawdown on both nominal and real (A) chosen.** Nominal-only (B) rejected: drops the "real returns are the default" framing for the drawdown tile. Real-only (C) rejected: disagrees with every published market-drawdown number users will compare against.
- **F8 — asset_class, account, security, tag-at-lot-level (A) chosen.** Skip tags (B) rejected: WORKSTREAMS calls them out explicitly. Position-level most-recent-buy tagging (C) rejected: loses information. Mixed-position "(untagged)" rule (D) rejected: most lots end up untagged. Tag-weight-sum > 100% is documented behavior, not a bug.
- **F9 — sparse + carry-forward + 7-day staleness (A) chosen.** Dense daily (B) rejected: pushes carry-forward to W6 unnecessarily. NYSE-calendar aware (C) rejected: dependency for a v1.0; carry-forward handles weekends correctly without it.

Open questions remain open — not blocked on this spec.

Implementation deviations, if any, will be appended below.
