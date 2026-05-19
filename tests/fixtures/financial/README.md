# Financial engine golden fixtures

Each `*.json` file in this directory is a hand-verified portfolio scenario
used by `tests/golden/financial-fixtures.test.ts`. See
[docs/specs/2026-05-18-financial-engine-slice-1.md §F7](../../../docs/specs/2026-05-18-financial-engine-slice-1.md).

## Format

```jsonc
{
  "name": "kebab-name",
  "description": "what this fixture exercises",
  "transactions": [
    {
      "id": 1,
      "account_id": 1,
      "security_id": 1,
      "transaction_type": "buy", // see TxType
      "transaction_date": "2026-01-15T00:00:00Z",
      "quantity": 100,
      "price_cents": 1000,        // integer cents, or null
      "amount_cents": 100000,     // integer cents (required)
      "fee_cents": null,          // integer cents, or null
      "currency_code": "USD"
    }
  ],
  "scenarios": [
    {
      "name": "fifo",
      "method": "fifo",                    // 'fifo' | 'lifo' | 'specific'
      "asOf": "2026-12-31T00:00:00Z",      // required; engine snapshot date
      "prices": null,                      // { "<security_id>": cents } | null
      "methodFor": null,                   // { "<account_id>": method } | null
      "lotSelections": null,               // { "<sellTxId>": [{sourceTxId, quantityFromLot}] } | null
      "expected": {
        "openPositions": [
          { "account_id": 1, "security_id": 1, "quantity": 50, "cost_basis_cents": 50000 }
        ],
        "closedLots": [
          { "sourceTxId": 1, "sellTxId": 3, "quantity": 50,
            "cost_basis_cents": 50000, "proceeds_cents": 75000, "realized_gain_cents": 25000 }
        ],
        "income": { "dividends_cents": 0, "interest_cents": 0, "fees_cents": 0 }
      }
    }
  ]
}
```

## Authoring

Fixtures are **hand-verified**. The expected block records pre-computed
values; the test runner asserts the engine matches. A regen script is
available (`scripts/regen-financial-fixtures.ts`) but it's a *typing
convenience*, not a rubber stamp — only re-run it after manually verifying
that the new engine output is correct.

## Coverage

The shipped set:

- `simple-buy-sell` — FIFO vs LIFO divergence on a half-lot sell
- `split-mid-history` — 2-for-1 split adjusts prior lots, basis preserved
- `multi-account` — same security, different methods per account
- `dividend-stream` — buys plus dividends; income separate from cost basis
- `realized-loss` — negative realized gain sign convention
