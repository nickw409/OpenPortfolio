import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { money, timestamps } from './columns';

// ─── accounts ───────────────────────────────────────────────────────────

export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  broker: text('broker'),
  // 'taxable' | 'tax_deferred' | 'tax_free' — constrained by app code, not SQLite CHECK.
  tax_treatment: text('tax_treatment').notNull(),
  // 'fifo' | 'lifo' | 'specific' — constrained by app code (see src/backend/financial/types.ts).
  cost_basis_method: text('cost_basis_method').notNull().default('fifo'),
  currency_code: text('currency_code').notNull().default('USD'),
  ...timestamps,
});

// ─── securities ─────────────────────────────────────────────────────────

export const securities = sqliteTable(
  'securities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    exchange: text('exchange').notNull(),
    // 'equity' | 'etf' | 'mutual_fund' | 'bond' | 'cash' | 'crypto' | 'other'
    asset_class: text('asset_class').notNull(),
    name: text('name'),
    cusip: text('cusip'),
    isin: text('isin'),
    currency_code: text('currency_code').notNull().default('USD'),
    ...timestamps,
  },
  (t) => ({
    symbolExchangeUnique: uniqueIndex('securities_symbol_exchange_unique').on(t.symbol, t.exchange),
  }),
);

// ─── transactions ───────────────────────────────────────────────────────

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    account_id: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    security_id: integer('security_id').references(() => securities.id),
    // 'buy' | 'sell' | 'dividend' | 'interest' | 'fee' | 'split'
    // | 'transfer_in' | 'transfer_out' | 'deposit' | 'withdrawal'
    transaction_type: text('transaction_type').notNull(),
    transaction_date: integer('transaction_date', { mode: 'timestamp_ms' }).notNull(),
    settlement_date: integer('settlement_date', { mode: 'timestamp_ms' }),
    quantity: real('quantity').notNull().default(0),
    price_cents: money('price_cents'),
    amount_cents: money('amount_cents').notNull(),
    fee_cents: money('fee_cents'),
    currency_code: text('currency_code').notNull().default('USD'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    accountDate: index('transactions_account_date_idx').on(t.account_id, t.transaction_date),
    securityDate: index('transactions_security_date_idx').on(t.security_id, t.transaction_date),
  }),
);

// ─── price_history (cache; no soft-delete) ──────────────────────────────

export const price_history = sqliteTable(
  'price_history',
  {
    security_id: integer('security_id')
      .notNull()
      .references(() => securities.id),
    price_date: integer('price_date', { mode: 'timestamp_ms' }).notNull(),
    close_cents: money('close_cents').notNull(),
    source: text('source').notNull(),
    fetched_at: integer('fetched_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.security_id, t.price_date] }),
  }),
);

// ─── cpi_data (cache; no soft-delete) ───────────────────────────────────

export const cpi_data = sqliteTable(
  'cpi_data',
  {
    series_id: text('series_id').notNull(),
    period_date: integer('period_date', { mode: 'timestamp_ms' }).notNull(),
    index_value: real('index_value').notNull(),
    fetched_at: integer('fetched_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.series_id, t.period_date] }),
  }),
);

// ─── dashboard_layouts + tile_configs ───────────────────────────────────

export const dashboard_layouts = sqliteTable('dashboard_layouts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  is_default: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
});

export const tile_configs = sqliteTable('tile_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  layout_id: integer('layout_id')
    .notNull()
    .references(() => dashboard_layouts.id, { onDelete: 'cascade' }),
  tile_type: text('tile_type').notNull(),
  position_json: text('position_json').notNull(),
  config_json: text('config_json').notNull().default('{}'),
  ...timestamps,
});

// ─── audit_log ──────────────────────────────────────────────────────────

export const audit_log = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entity_type: text('entity_type').notNull(),
    entity_id: integer('entity_id').notNull(),
    // 'insert' | 'update' | 'delete'
    action: text('action').notNull(),
    before_json: text('before_json'),
    after_json: text('after_json'),
    at_ms: integer('at_ms', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    actor: text('actor').notNull().default('user'),
  },
  (t) => ({
    entityIdx: index('audit_log_entity_idx').on(t.entity_type, t.entity_id, t.at_ms),
    chronoIdx: index('audit_log_chrono_idx').on(t.at_ms),
  }),
);

// ─── tagging ────────────────────────────────────────────────────────────

export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    color: text('color'),
    ...timestamps,
  },
  (t) => ({
    nameUnique: uniqueIndex('tags_name_unique').on(t.name),
  }),
);

export const transaction_tags = sqliteTable(
  'transaction_tags',
  {
    transaction_id: integer('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    tag_id: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.transaction_id, t.tag_id] }),
  }),
);

// Positions are derived by the financial engine at src/backend/financial/.
// The previous SQL `positions` view summed transaction quantities directly,
// which mishandled corporate actions (notably stock splits). Slice 1 of the
// financial engine drops the view; engine functions are the single source
// of truth. See docs/specs/2026-05-18-financial-engine-slice-1.md §F3.
