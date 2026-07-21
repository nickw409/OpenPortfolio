import { YahooProvider } from './providers/yahoo';
import { PolygonProvider } from './providers/polygon';
import {
  type Fetcher,
  type PriceProvider,
  type PriceProviderConfig,
  type PriceProviderKind,
} from './types';

export function createPriceProvider(config: PriceProviderConfig, fetcher?: Fetcher): PriceProvider {
  const f = fetcher ?? defaultFetcher;
  switch (config.kind) {
    case 'yahoo':
      return new YahooProvider(f);
    case 'polygon':
      if (!config.apiKey) {
        throw new Error('Polygon provider requires an API key');
      }
      return new PolygonProvider(f, config.apiKey);
    default: {
      const _exhaustive: never = config.kind;
      throw new Error(`Unknown provider kind: ${_exhaustive as string}`);
    }
  }
}

export function priceProviderKindFromEnv(): PriceProviderKind | null {
  const env = process.env.OPENPORTFOLIO_PRICE_PROVIDER;
  if (env === 'yahoo' || env === 'polygon') return env;
  return null;
}

export function priceProviderConfigFromEnv(): PriceProviderConfig | null {
  const kind = priceProviderKindFromEnv();
  if (kind == null) return null;
  return {
    kind,
    apiKey: process.env.OPENPORTFOLIO_POLYGON_API_KEY,
  };
}

async function defaultFetcher(
  url: string,
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  const res = await fetch(url);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
}
