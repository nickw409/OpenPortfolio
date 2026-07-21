import type { TxTypeName } from '@shared/schemas/transaction';

import type { ColumnMapping } from './mapping';

export type BrokerId = 'fidelity' | 'schwab' | 'vanguard' | 'ibkr';

export interface BrokerPreset {
  id: BrokerId;
  label: string;
  mapping: ColumnMapping;
  normalizeType: (raw: string) => TxTypeName | null;
}

function keywordType(raw: string): TxTypeName | null {
  const s = raw.trim().toLowerCase();
  if (/(you bought|^buy\b|purchase|reinvest)/.test(s)) return 'buy';
  if (/(you sold|^sell\b|redemption)/.test(s)) return 'sell';
  if (/dividend/.test(s)) return 'dividend';
  if (/interest/.test(s)) return 'interest';
  if (/(fee|commission)/.test(s)) return 'fee';
  if (/split/.test(s)) return 'split';
  if (/(transfer in|received)/.test(s)) return 'transfer_in';
  if (/(transfer out|delivered)/.test(s)) return 'transfer_out';
  if (/(deposit|contribution)/.test(s)) return 'deposit';
  if (/(withdrawal|distribution)/.test(s)) return 'withdrawal';
  return null;
}

export const BROKER_PRESETS: Record<BrokerId, BrokerPreset> = {
  fidelity: {
    id: 'fidelity',
    label: 'Fidelity',
    mapping: {
      transaction_date: 'Run Date',
      transaction_type: 'Action',
      symbol: 'Symbol',
      quantity: 'Quantity',
      price: 'Price ($)',
      amount: 'Amount ($)',
      fee: 'Commission ($)',
    },
    normalizeType: keywordType,
  },
  schwab: {
    id: 'schwab',
    label: 'Charles Schwab',
    mapping: {
      transaction_date: 'Date',
      transaction_type: 'Action',
      symbol: 'Symbol',
      quantity: 'Quantity',
      price: 'Price',
      amount: 'Amount',
      fee: 'Fees & Comm',
    },
    normalizeType: keywordType,
  },
  vanguard: {
    id: 'vanguard',
    label: 'Vanguard',
    mapping: {
      transaction_date: 'Trade Date',
      transaction_type: 'Transaction Type',
      symbol: 'Symbol',
      quantity: 'Shares',
      price: 'Share Price',
      amount: 'Principal Amount',
      fee: 'Commission Fees',
    },
    normalizeType: keywordType,
  },
  ibkr: {
    id: 'ibkr',
    label: 'Interactive Brokers',
    mapping: {
      transaction_date: 'Date/Time',
      transaction_type: 'Buy/Sell',
      symbol: 'Symbol',
      quantity: 'Quantity',
      price: 'T. Price',
      amount: 'Proceeds',
      fee: 'Comm/Fee',
    },
    normalizeType: keywordType,
  },
};

export function getPreset(id: BrokerId): BrokerPreset {
  return BROKER_PRESETS[id];
}
