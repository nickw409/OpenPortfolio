import { eq, and, sql, gte } from 'drizzle-orm';

import { provider_requests } from '@backend/db/schema';
import type { Db } from '@backend/db/client';

export interface RateLimitRule {
  // Minimum milliseconds between requests. Null means no spacing rule.
  minIntervalMs: number | null;
  // Maximum requests in the rolling window. Null means no cap.
  windowMax: number | null;
  // Window length in milliseconds.
  windowMs: number | null;
}

export interface RateLimitCheck {
  allowed: boolean;
  nextAllowedAt: Date | null;
  windowUsed: number;
  windowRemaining: number | null;
}

export class RateLimiter {
  constructor(private readonly db: Db) {}

  check(provider: string, rule: RateLimitRule): RateLimitCheck {
    const now = new Date();

    let nextAllowedAt: Date | null = null;
    if (rule.minIntervalMs != null) {
      const lastRow = this.db
        .select({ requested_at: provider_requests.requested_at })
        .from(provider_requests)
        .where(eq(provider_requests.provider, provider))
        .orderBy(sql`${provider_requests.requested_at} DESC`)
        .limit(1)
        .get();
      if (lastRow) {
        const next = new Date(lastRow.requested_at.getTime() + rule.minIntervalMs);
        if (next > now) {
          nextAllowedAt = next;
        }
      }
    }

    let windowUsed = 0;
    let windowRemaining: number | null = null;
    if (rule.windowMax != null && rule.windowMs != null) {
      const windowStart = new Date(now.getTime() - rule.windowMs);
      const agg = this.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(provider_requests)
        .where(
          and(
            eq(provider_requests.provider, provider),
            gte(provider_requests.requested_at, windowStart),
          ),
        )
        .get();
      windowUsed = agg?.count ?? 0;
      windowRemaining = Math.max(0, rule.windowMax - windowUsed);
      if (windowRemaining <= 0) {
        // Block until the oldest request in the window ages out. Approximate using now + 1ms of window.
        nextAllowedAt = new Date(now.getTime() + rule.windowMs);
      }
    }

    return {
      allowed: nextAllowedAt == null,
      nextAllowedAt,
      windowUsed,
      windowRemaining,
    };
  }

  record(
    provider: string,
    endpoint: string,
    requestedAt: Date,
    symbol: string | null,
    success: boolean,
  ): void {
    this.db
      .insert(provider_requests)
      .values({
        provider,
        endpoint,
        requested_at: requestedAt,
        symbol,
        success,
      })
      .run();
  }
}

export const PROVIDER_RULES: Record<'polygon' | 'yahoo', RateLimitRule> = {
  yahoo: { minIntervalMs: 2000, windowMax: null, windowMs: null },
  // Polygon free tier: 5 API calls / minute. We do not enforce a daily cap.
  polygon: { minIntervalMs: 12_000, windowMax: 5, windowMs: 60_000 },
};
