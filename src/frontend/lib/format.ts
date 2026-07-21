export { format as formatMoney } from '@shared/money';

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

// Type-only re-export so callers don't need a separate import.
export type { Money } from '@shared/money';
