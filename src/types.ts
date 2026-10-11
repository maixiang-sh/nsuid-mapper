/** Product kind inferred from the redirect path segment. */
export type ProductPathKind = 'titles' | 'aocs' | 'bundles' | 'demos' | 'unknown';

/**
 * Result of resolving AppID → regional catalog product via
 * `https://ec.nintendo.com/apps/{appId}/{REGION}`.
 */
export interface AppIdResolveResult {
  /** 16-hex application / title id used as input. */
  appId: string;
  /** Region code used in the request (uppercase). */
  region: string;
  /** Validated acdIndex that was requested. */
  acdIndex: number;
  /** Resolved 14-digit catalog nsuid. */
  nsuid: string;
  /**
   * Path kind when Location is `/XX/lang/{kind}/{nsuid}`
   * (`titles` / `aocs` / `bundles` / …). US/EU absolute redirects → `unknown`.
   */
  pathKind: ProductPathKind;
  /** Best-effort item kind from nsuid prefix (7001/7005/…). */
  itemKind: ItemKind;
  /** Raw `Location` header from the first redirect hop. */
  location: string;
  /**
   * Absolute first-hop redirect target. US/EU targets may be intermediate
   * redirectors that eventually land on a human-readable slug page.
   */
  redirectUrl: string;
  /** Language segment when present (`ja`, `zh`, `en`, …). */
  language?: string;
}

/** Nintendo eShop item kind heuristic from nsuid prefix. */
export type ItemKind = 'title' | 'demo' | 'dlc' | 'bundle' | 'consumable' | 'unknown';

export interface RequestOptions {
  /** AbortSignal / per-call headers and transport overrides. */
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Injectable for tests; defaults to the global. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout, including retries and backoff on either upstream. Default: 10 seconds. */
  timeoutMs?: number;
  /** Extra attempts after the first on either upstream. Default: 2; maximum: 5. */
  retries?: number;
}

export interface ResolveOptions extends RequestOptions {
  /**
   * Multi-SKU selector for the same appId in one region (0-based).
   * Out-of-range values fall back to 0 server-side.
   * Default: `0` (canonical / first SKU).
   */
  acdIndex?: number;
}

export interface EnumerateOptions extends RequestOptions {
  /**
   * Max acdIndex to probe (inclusive upper bound is max-1).
   * Stops early when redirect target repeats index 0.
   * Default: {@link DEFAULT_ENUMERATE_MAX}.
   */
  max?: number;
}
