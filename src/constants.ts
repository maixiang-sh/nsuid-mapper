/** Unified AppID cross-region entry host. */
export const EC_BASE = 'https://ec.nintendo.com';

/**
 * Entry path template:
 *   `https://ec.nintendo.com/apps/{appId}/{REGION}`
 * Optional query: `?acdIndex=N` (0-based SKU index; out-of-range falls back to 0).
 */
export const APPS_PATH = '/apps';

export const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (compatible; nintendo-store-nsuid-mapper/0.1; +https://ec.nintendo.com)',
  // Avoid following client RSC prefetch noise; we only need Location.
  'Accept-Language': 'en,ja;q=0.9',
};

/**
 * Common storefront regions that work with `/apps/{appId}/{REGION}`
 * (uppercase ISO 3166-1 alpha-2 as used by the edge redirector).
 *
 * Note: not every code yields a product Location (e.g. KR may redirect to a
 * generic store page; TW may return 200 SPA HTML without a server redirect).
 */
export const COMMON_REGIONS = [
  'JP',
  'US',
  'CA',
  'MX',
  'GB',
  'DE',
  'FR',
  'ES',
  'IT',
  'NL',
  'AU',
  'NZ',
  'HK',
  'KR',
] as const;

export type CommonRegion = (typeof COMMON_REGIONS)[number];

/** Safety cap when enumerating acdIndex until redirect repeats. */
export const DEFAULT_ENUMERATE_MAX = 16;
export const MAX_ENUMERATE_LIMIT = 32;
export const DEFAULT_TIMEOUT_MS = 10_000;
