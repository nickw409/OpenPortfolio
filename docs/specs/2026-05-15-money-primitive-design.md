# Money primitive — design spec

**Status:** Proposed
**Date:** 2026-05-15
**Workstream:** [docs/WORKSTREAMS.md](../WORKSTREAMS.md) §1 Database foundation and money types

## Context

WORKSTREAMS §1 calls for a `Money` integer-cents type plus a small library of operations that "refuse to mix `Money` with `number`". This spec works through the design forks before implementation. The cross-cutting invariant *"Money is integer cents. No floats, ever."* (WORKSTREAMS §"Cross-cutting invariants") is binding.

Four forks: brand mechanism, operation set, enforcement strategy, location.

---

## M1. Brand mechanism

How `Money` is distinguished from a raw `number` at the type level.

- **A. Intersection brand** — `type Money = number & { readonly __brand: 'money' }`. Zero allocation, identical to `number` at runtime, plays nicely with Drizzle `integer()` columns and `JSON.stringify`. Castable away with `as Money` — relies on the lint rule (M3) to catch raw arithmetic.
- **B. Class wrapper** — `class Money { constructor(public cents: number) {} }`. True encapsulation; arithmetic operators don't compile against instances. But: every DB row mapping needs `Money.of(row.amount)`, every comparison needs a method (`.eq`, `.lt`), allocations on every operation, awkward serialization.
- **C. Opaque type via private symbol** — class with private brand field and static factory. Halfway between A and B; still allocates.

**Recommendation: A.** Industry-standard pattern in TS finance code. The "castable" downside is paid for once by writing the lint rule (M3-A) and forever after by lint catching violations. B's allocation cost compounds across millions of arithmetic operations on long histories.

---

## M2. Operation set

Operations the library exposes. All take and return `Money` except where noted.

Required:
- `add(a, b)`, `subtract(a, b)`, `negate(a)`, `abs(a)`
- `compare(a, b) → -1 | 0 | 1`, plus `eq`, `lt`, `lte`, `gt`, `gte` derived from it
- `sum(values: Money[])` — variadic-style for cleaner aggregation
- `multiplyByRatio(m: Money, ratio: number) → Money` — for percentage / weighting; ratio is a plain number
- `divideByRatio(m: Money, divisor: number) → Money` — for splitting; divisor is a plain number
- `divideByMoney(numerator: Money, denominator: Money) → number` — returns a ratio, e.g. for return calculation; output is a plain number, deliberately not Money
- `format(m: Money, opts?: { currencyCode?: string; locale?: string }) → string`
- `parse(text: string) → Money` — for CSV import; throws on invalid input

**Rounding policy on multiply/divide:** half-to-even (banker's rounding). IEEE 754 default; standard for cumulative financial work; doesn't bias up. Implemented manually since JS `Math.round` rounds half-away-from-zero.

**Constructor (`Money.of(cents: number)`):** rejects `NaN`, `Infinity`, `-Infinity`, non-integer (cents are integer by definition). Throws `RangeError` with a descriptive message — these are programmer errors, not user errors.

Out of scope (deliberately):
- Multi-currency conversion. `Money` is unit-less; the unit is carried by adjacent columns (see [initial-schema spec](2026-05-15-initial-schema-design.md) S3).
- Decimal places beyond cents. The product target is USD-style currencies; if BTC ever lands, that's a v2 conversation about fractional units.

---

## M3. Enforcement — preventing raw arithmetic on `Money` values

The forcing invariant. If `const total = balance + fee;` compiles silently when `balance: Money` and `fee: Money`, the type is theater.

- **A. Custom ESLint rule** — flags `+ - * /` and unary `-` when at least one operand is typed as `Money`. Real but writeable in ~80–150 lines using `@typescript-eslint/utils` (the rule is `noRestrictedSyntax` flavored, with TypeChecker access for type lookups).
- **B. Test-only enforcement** — a unit test that walks `src/` AST and reports any arithmetic operator next to a `Money`-typed expression. Faster to write, but only catches violations on test runs (not in editor) and depends on type information at scan time (have to load tsc).
- **C. Both A and B** — belt and suspenders.
- **D. Type-level only** — declare arithmetic as `never` on Money. *Not possible in TypeScript* — the language has no way to intercept binary operators on primitive types.

**Recommendation: A.** B alone is too easy to evade; the failure surfaces at CI time rather than typing time. C is overkill for a one-developer project. The lint rule is a one-time write that pays back forever.

The rule will live at `eslint-rules/no-money-arithmetic.js` and be loaded via the flat config's plugin slot. Test fixtures pinned in `eslint-rules/no-money-arithmetic.test.ts`.

---

## M4. Location

`src/shared/money.ts` (the directory exists in the scaffold). Frontend display layer needs `format()`, so the module has to be in `shared/`, not `backend/`. No imports from React or Node-only modules.

The lint rule itself lives at `eslint-rules/` (root), not `src/`, so it's not bundled into the runtime artifact.

---

## Test plan

- Coverage target: **95%+** per WORKSTREAMS invariant on financial-calculation modules.
- Property-based tests via `fast-check` (proposed dev dep). Properties:
  - `add` is commutative and associative
  - `subtract(a, a) === 0`
  - `sum([])` is the zero element; `sum(xs)` equals reducing with `add`
  - `multiplyByRatio(m, 0)` is zero; `multiplyByRatio(m, 1)` equals `m`
  - `multiplyByRatio(m, r)` then `divideByRatio(_, r)` round-trips within rounding tolerance
  - `divideByMoney(a, a) === 1` for non-zero `a`
  - `negate(negate(a)) === a`
  - `format → parse` round-trips for canonical-form output
- Example tests for the rounding policy: explicit cases that pin half-to-even behavior at the boundary (`0.5 → 0`, `1.5 → 2`, `-0.5 → 0`, `-1.5 → -2`).
- Constructor-rejection tests for `NaN`, `Infinity`, `1.5`, `-0`.

---

## Open questions

- **Property-based testing dep.** Adding `fast-check` (~200 KB dev dep). Reasonable to take given the algebraic-identity surface area; flagged for explicit user approval.
- **Currency code in `format`.** USD-by-default is fine for v1.0, but does the formatter need a `Intl.NumberFormat` integration now or later? Lean: now, since it's a one-line wrapper.

---

## Decisions and rationale

Approved 2026-05-15.

- **M1 — Intersection brand (A) chosen.** B (class wrapper) rejected for per-operation allocation cost; that cost compounds across long histories. C (opaque + symbol) rejected for the same reason at smaller magnitude. The lint rule (M3-A) takes the structural-safety load that B's encapsulation would have carried.
- **M2 — Operation set approved as proposed.** Half-to-even rounding adopted as the standard for cumulative financial work. `parse → format` round-trip is a tested invariant. Constructor rejects `NaN` / `Infinity` / non-integer.
- **M3 — Custom ESLint rule (A) chosen.** B (test-only scan) rejected for editor-time invisibility — the violation only surfaces at CI, after the developer has already moved on. C (both A and B) rejected as overkill at current contributor count. D (type-level) rejected as impossible in TS.
- **M4 — `src/shared/money.ts` confirmed.** Lint rule lives at `eslint-rules/no-money-arithmetic.js` (root, not `src/`) so it's not bundled into the runtime artifact.
- **fast-check approved as a dev dep.** Algebraic-identity surface area justifies the ~200 KB cost; one property test counts as many examples toward the 95% coverage target.

No deviations from the proposed spec at approval time. Implementation deviations, if any, will be appended below.
