// Golden fixture test runner. For each JSON fixture under
// tests/fixtures/financial/, executes every scenario through the engine
// and asserts the expected openPositions, closedLots, and income summary.
//
// See docs/specs/2026-05-18-financial-engine-slice-1.md §F7. Fixtures are
// hand-verified; the regen script (scripts/regen-financial-fixtures.ts) is
// a typing convenience, not a rubber stamp.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ofCents, type Money } from '@shared/money';

import {
  computeIncomeStream,
  computePortfolio,
  type CostBasisMethod,
  type LotSelectionMap,
  type PriceMap,
  type Tx,
  type TxType,
} from '@backend/financial';

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'financial');

interface FixtureTx {
  id: number;
  account_id: number;
  security_id: number | null;
  transaction_type: TxType;
  transaction_date: string;
  quantity: number;
  price_cents: number | null;
  amount_cents: number;
  fee_cents: number | null;
  currency_code: string;
}

interface FixtureExpectedPosition {
  account_id: number;
  security_id: number;
  quantity: number;
  cost_basis_cents: number;
}

interface FixtureExpectedClosedLot {
  sourceTxId: number;
  sellTxId: number;
  quantity: number;
  cost_basis_cents: number;
  proceeds_cents: number;
  realized_gain_cents: number;
}

interface FixtureScenario {
  name: string;
  method: CostBasisMethod;
  asOf: string;
  prices: Record<string, number> | null;
  methodFor: Record<string, CostBasisMethod> | null;
  lotSelections: Record<string, { sourceTxId: number; quantityFromLot: number }[]> | null;
  expected: {
    openPositions: FixtureExpectedPosition[];
    closedLots: FixtureExpectedClosedLot[];
    income: {
      dividends_cents: number;
      interest_cents: number;
      fees_cents: number;
    };
  };
}

interface Fixture {
  name: string;
  description: string;
  transactions: FixtureTx[];
  scenarios: FixtureScenario[];
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture);
}

function toTx(t: FixtureTx): Tx {
  return {
    id: t.id,
    account_id: t.account_id,
    security_id: t.security_id,
    transaction_type: t.transaction_type,
    transaction_date: new Date(t.transaction_date),
    quantity: t.quantity,
    price_cents: t.price_cents === null ? null : (ofCents(t.price_cents) as Money),
    amount_cents: ofCents(t.amount_cents),
    fee_cents: t.fee_cents === null ? null : (ofCents(t.fee_cents) as Money),
    currency_code: t.currency_code,
  };
}

function toPriceMap(prices: Record<string, number> | null): PriceMap | undefined {
  if (!prices) return undefined;
  return new Map(Object.entries(prices).map(([k, v]) => [Number(k), ofCents(v)]));
}

function toMethodFor(
  defaultMethod: CostBasisMethod,
  methodFor: Record<string, CostBasisMethod> | null,
): CostBasisMethod | ((accountId: number) => CostBasisMethod) {
  if (!methodFor) return defaultMethod;
  return (accountId: number) => methodFor[String(accountId)] ?? defaultMethod;
}

function toLotSelections(
  lotSelections: Record<string, { sourceTxId: number; quantityFromLot: number }[]> | null,
): LotSelectionMap | undefined {
  if (!lotSelections) return undefined;
  return new Map(Object.entries(lotSelections).map(([k, v]) => [Number(k), v]));
}

const fixtures = loadFixtures();

describe('financial engine — golden fixtures', () => {
  if (fixtures.length === 0) {
    it.skip('no fixtures loaded', () => {});
    return;
  }

  for (const fixture of fixtures) {
    // Slice-2 fixtures (valuation / TWR / drawdown shapes) use a different
    // top-level structure and are tested by their own dedicated test files.
    // Skip any fixture that lacks the slice-1 `scenarios` array.
    if (!Array.isArray(fixture.scenarios)) continue;

    describe(fixture.name, () => {
      const txns = fixture.transactions.map(toTx);

      for (const scenario of fixture.scenarios) {
        it(scenario.name, () => {
          const { snapshot, closedLots } = computePortfolio(txns, {
            method: toMethodFor(scenario.method, scenario.methodFor),
            asOf: new Date(scenario.asOf),
            prices: toPriceMap(scenario.prices),
            lotSelections: toLotSelections(scenario.lotSelections),
          });

          const actualPositions = snapshot.positions
            .map((p) => ({
              account_id: p.account_id,
              security_id: p.security_id,
              quantity: p.quantity,
              cost_basis_cents: Number(p.cost_basis_cents),
            }))
            .sort(byAccountSecurity);
          const expectedPositions = [...scenario.expected.openPositions].sort(byAccountSecurity);
          expect(actualPositions).toEqual(expectedPositions);

          const actualClosed = closedLots
            .map((cl) => ({
              sourceTxId: cl.sourceTxId,
              sellTxId: cl.sellTxId,
              quantity: cl.quantity,
              cost_basis_cents: Number(cl.cost_basis_cents),
              proceeds_cents: Number(cl.proceeds_cents),
              realized_gain_cents: Number(cl.realized_gain_cents),
            }))
            .sort(bySellThenSource);
          const expectedClosed = [...scenario.expected.closedLots].sort(bySellThenSource);
          expect(actualClosed).toEqual(expectedClosed);

          const income = computeIncomeStream(txns);
          expect({
            dividends_cents: Number(income.dividends_cents),
            interest_cents: Number(income.interest_cents),
            fees_cents: Number(income.fees_cents),
          }).toEqual(scenario.expected.income);
        });
      }
    });
  }
});

function byAccountSecurity(
  a: { account_id: number; security_id: number },
  b: { account_id: number; security_id: number },
): number {
  if (a.account_id !== b.account_id) return a.account_id - b.account_id;
  return a.security_id - b.security_id;
}

function bySellThenSource(
  a: { sellTxId: number; sourceTxId: number },
  b: { sellTxId: number; sourceTxId: number },
): number {
  if (a.sellTxId !== b.sellTxId) return a.sellTxId - b.sellTxId;
  return a.sourceTxId - b.sourceTxId;
}
