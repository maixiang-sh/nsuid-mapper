import {
  APPS_PATH,
  DEFAULT_ENUMERATE_MAX,
  DEFAULT_HEADERS,
  EC_BASE,
  MAX_ENUMERATE_LIMIT,
} from '../constants.ts';
import { NsuidMapError } from '../errors.ts';
import { backoffDelay, normalizeRetries, waitForRetry } from '../retry.ts';
import { normalizeTimeoutMs } from '../timeout.ts';
import {
  isCatalogId,
  itemKindFromNsuid,
  normalizeRegion,
  parseAcdIndex,
  parseAppId,
} from '../ids.ts';
import type {
  AppIdResolveResult,
  EnumerateOptions,
  ProductPathKind,
  ResolveOptions,
} from '../types.ts';

export interface BuildAppIdUrlOptions {
  /** 0-based multi-SKU index. Omitted → server default (0). */
  acdIndex?: number;
  /** Override host (default https://ec.nintendo.com). */
  baseUrl?: string;
}

/**
 * Build the unified AppID entry URL.
 *
 * ```text
 * https://ec.nintendo.com/apps/{appId}/{REGION}
 * https://ec.nintendo.com/apps/{appId}/{REGION}?acdIndex=1
 * ```
 */
export function buildAppIdUrl(
  appId: string,
  region: string,
  options: BuildAppIdUrlOptions = {},
): string {
  const id = parseAppId(appId);
  const reg = normalizeRegion(region);
  const acdIndex = parseAcdIndex(options.acdIndex);
  const base = (options.baseUrl ?? EC_BASE).replace(/\/$/, '');
  const url = new URL(`${base}${APPS_PATH}/${id}/${reg}`);
  if (acdIndex > 0) {
    url.searchParams.set('acdIndex', String(acdIndex));
  }
  // acdIndex=0 is the default; omit query for cleaner canonical URL
  return url.toString();
}

interface AppIdRedirectorOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  defaultEnumerateMax?: number;
  timeoutMs?: number;
  retries?: number;
}

/**
 * Adapter for `ec.nintendo.com/apps/{appId}/{region}`.
 *
 * All redirector-specific HTTP behavior and Location parsing stays here so
 * changes to this upstream do not leak into the SDK facade or Savanna adapter.
 */
export class AppIdRedirector {
  private readonly baseUrl: string;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultEnumerateMax: number;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: AppIdRedirectorOptions = {}) {
    this.baseUrl = (options.baseUrl ?? EC_BASE).replace(/\/$/, '');
    this.customHeaders = { ...options.headers };
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultEnumerateMax = parseEnumerateMax(
      options.defaultEnumerateMax ?? DEFAULT_ENUMERATE_MAX,
    );
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    this.retries = normalizeRetries(options.retries);
  }

  buildUrl(appId: string, region: string, acdIndex?: number): string {
    return buildAppIdUrl(appId, region, { baseUrl: this.baseUrl, acdIndex });
  }

  async resolveAppId(
    appId: string,
    region: string,
    options: ResolveOptions = {},
  ): Promise<AppIdResolveResult | null> {
    const id = parseAppId(appId);
    const reg = normalizeRegion(region);
    const acdIndex = parseAcdIndex(options.acdIndex);
    const url = this.buildUrl(id, reg, acdIndex);
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? this.timeoutMs);
    const retries = normalizeRetries(options.retries ?? this.retries);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutController.signal])
      : timeoutController.signal;
    const fetchImpl = options.fetch ?? this.fetchImpl;

    const headers = mergeHeaders(DEFAULT_HEADERS, this.customHeaders, options.headers);
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    try {
      // All attempts and backoff share this request's timeout and caller signal.
      for (let attempt = 0; ; attempt++) {
        try {
          if (signal.aborted) throw signal.reason;
          const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal, headers });
          try {
            // Even buffered headers can be returned after the caller cancels.
            if (signal.aborted) throw signal.reason;
            if (res.status === 404) return null;
            if (res.status >= 300 && res.status < 400) {
              const location = res.headers.get('location');
              if (!location) {
                throw new NsuidMapError(`Redirect without Location: ${url}`, {
                  status: res.status,
                  url,
                });
              }
              return parseResolveResult({
                appId: id,
                region: reg,
                acdIndex,
                location,
                baseUrl: this.baseUrl,
              });
            }
            if (res.status === 200) return null;
            throw new NsuidMapError(`Unexpected status ${res.status} for AppID resolve: ${url}`, {
              status: res.status,
              url,
              kind: 'http',
              retryable: res.status === 429 || res.status >= 500,
            });
          } finally {
            // Only headers are needed. Release bodies before retrying or returning.
            void res.body?.cancel().catch(() => {});
          }
        } catch (cause) {
          if (signal.aborted) throw classifyAbort(url, options.signal, timeoutMs, cause);
          const error =
            cause instanceof NsuidMapError
              ? cause
              : new NsuidMapError(
                  `AppID resolve failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                  { url, cause, kind: 'network', retryable: true },
                );
          if (!error.retryable || attempt >= retries) throw error;
          try {
            await waitForRetry(backoffDelay(attempt), sleep, signal);
          } catch (waitError) {
            if (signal.aborted) throw classifyAbort(url, options.signal, timeoutMs, waitError);
            throw waitError;
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async enumerateSkus(
    appId: string,
    region: string,
    options: EnumerateOptions = {},
  ): Promise<AppIdResolveResult[]> {
    const max = parseEnumerateMax(options.max ?? this.defaultEnumerateMax);
    const first = await this.resolveAppId(appId, region, { ...options, acdIndex: 0 });
    if (!first) return [];

    const out: AppIdResolveResult[] = [first];
    for (let i = 1; i < max; i++) {
      const next = await this.resolveAppId(appId, region, { ...options, acdIndex: i });
      if (!next || next.nsuid === first.nsuid || out.some((item) => item.nsuid === next.nsuid)) {
        break;
      }
      out.push(next);
    }
    return out;
  }
}

/** Map storefront path segment to the redirector result kind. */
export function pathKindFromSegment(segment: string | undefined): ProductPathKind {
  switch ((segment ?? '').toLowerCase()) {
    case 'titles':
      return 'titles';
    case 'aocs':
      return 'aocs';
    case 'bundles':
      return 'bundles';
    case 'demos':
      return 'demos';
    default:
      return 'unknown';
  }
}

/** Extract a 14-digit nsuid from a relative or absolute redirect Location. */
export function extractNsuidFromLocation(location: string): string | undefined {
  const loc = location.trim();
  if (!loc) return undefined;

  try {
    const absolute = loc.startsWith('http')
      ? new URL(loc)
      : new URL(loc, 'https://ec.nintendo.com');
    for (const [key, value] of absolute.searchParams) {
      if (key.toLowerCase() === 'nsuid' && isCatalogId(value)) return value.trim();
    }
  } catch {
    // Fall through to the known path shapes.
  }

  const posRedirect = loc.match(/\/pos-redirect\/(\d{14})\b/i);
  if (posRedirect?.[1]) return posRedirect[1];

  const storefrontPath = loc.match(
    /\/(?:[A-Za-z]{2})\/(?:[a-zA-Z-]+)\/(?:titles|aocs|bundles|demos)\/(\d{14})\b/i,
  );
  if (storefrontPath?.[1]) return storefrontPath[1];

  if (isCatalogId(loc)) return loc;
  const trailingPath = loc.match(/\/(\d{14})\/?(?:[?#]|$)/);
  if (trailingPath?.[1] && isCatalogId(trailingPath[1])) return trailingPath[1];
  return undefined;
}

/** Parse the structured `/REGION/language/kind/nsuid` Location shape. */
export function parseStorefrontPath(location: string): {
  region?: string;
  language?: string;
  pathKind: ProductPathKind;
  nsuid?: string;
} {
  const pathOnly = location.split('?')[0] ?? location;
  const match = pathOnly.match(
    /^\/([A-Za-z]{2})\/([a-zA-Z-]+)\/(titles|aocs|bundles|demos)\/(\d{14})\/?$/i,
  );
  if (!match) {
    return { pathKind: 'unknown', nsuid: extractNsuidFromLocation(location) };
  }
  return {
    region: match[1]!.toUpperCase(),
    language: match[2]!.toLowerCase(),
    pathKind: pathKindFromSegment(match[3]),
    nsuid: match[4],
  };
}

function classifyAbort(
  url: string,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  cause: unknown,
): NsuidMapError {
  const abortedByCaller = callerSignal?.aborted;
  return new NsuidMapError(
    abortedByCaller
      ? `AppID resolve aborted by caller: ${url}`
      : `AppID resolve timed out after ${timeoutMs}ms: ${url}`,
    { url, cause, kind: abortedByCaller ? 'abort' : 'timeout' },
  );
}

function parseEnumerateMax(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ENUMERATE_LIMIT) {
    throw new TypeError(
      `enumerate max must be a safe integer between 1 and ${MAX_ENUMERATE_LIMIT}`,
    );
  }
  return value;
}

function parseResolveResult(args: {
  appId: string;
  region: string;
  acdIndex: number;
  location: string;
  baseUrl: string;
}): AppIdResolveResult | null {
  const { appId, region, acdIndex, location, baseUrl } = args;
  const store = parseStorefrontPath(location);
  const nsuid = store.nsuid ?? extractNsuidFromLocation(location);
  if (!nsuid) return null;

  let redirectUrl: string;
  try {
    redirectUrl = new URL(location, baseUrl).toString();
  } catch {
    redirectUrl = location.startsWith('http') ? location : `${baseUrl}${location}`;
  }

  return {
    appId,
    region,
    acdIndex,
    nsuid,
    pathKind: store.pathKind,
    itemKind: itemKindFromNsuid(nsuid),
    location,
    redirectUrl,
    language: store.language,
  };
}

function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) headers.set(name, value);
  }
  return headers;
}
