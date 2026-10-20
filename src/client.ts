import { contextFor, mapInto, type NsuidMapping } from './mapping.ts';
import { mergeHeaders } from './headers.ts';
import { normalizeRegion, parseNsuid } from './ids.ts';
import type {
  AppIdResolveResult,
  EnumerateOptions,
  RequestOptions,
  ResolveOptions,
} from './types.ts';
import { AppIdRedirector } from './upstreams/redirector.ts';
import { fetchAppIds, fetchIdentities } from './upstreams/savanna.ts';

export interface NsuidMapperOptions {
  /** Override host (default https://ec.nintendo.com). */
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  /** Default region when methods omit region (e.g. JP). */
  defaultRegion?: string;
  /** Default max when enumerating multi-SKU (default 16). */
  defaultEnumerateMax?: number;
  /** Timeout applied to each Nintendo request. Default: 10 seconds. */
  timeoutMs?: number;
  /** Extra attempts on either upstream for network, 429 and 5xx failures. Default: 2. */
  retries?: number;
}

/**
 * Most countries accepted in one `to` list.
 *
 * A map fans out per country and all countries fire at once. A normal bundle
 * normally costs two requests per country; linked editions, multiple parents
 * and pagination add requests, performed sequentially within each country. Eight
 * keeps the concurrent fan-out bounded and is enough for one country per
 * publishing region (JPN USA EUR AUS TWN KOR CHN SEA). Split a longer list into
 * several calls, deliberately.
 */
export const MAX_REGIONS_PER_MAP = 8;

/** Where a source nsuid lives, and which regions to map it into. */
export interface MapOptions extends RequestOptions {
  /** Region the source nsuid belongs to. An nsuid only resolves in its own. */
  from: string;
  /** Up to {@link MAX_REGIONS_PER_MAP} countries. Duplicates are collapsed. */
  to: string[];
}

/**
 * Resolves product ids in both directions, and across regions.
 *
 * | Direction              | Method                                        |
 * | ---------------------- | --------------------------------------------- |
 * | nsuid → appId          | `resolveNsuidToAppId` / `resolveNsuidsToAppIds` |
 * | appId → nsuid          | `resolveAppIdToNsuid` / `resolveAppId`        |
 * | nsuid → nsuid, per region | `mapNsuid` (one nsuid, up to 8 countries) |
 *
 * The two halves come from different upstreams. `nsuid → appId` is a batched
 * GraphQL query; `appId → nsuid` is `ec.nintendo.com/apps/{appId}/{REGION}`,
 * a redirector whose `Location` carries the nsuid — Savanna cannot reverse an
 * appId itself (`applicationItem(applicationId:)` is a 400). Cross-region
 * mapping in `mapping.ts` chains the two.
 *
 * The `/apps` half resolves base **Application** ids to `7001` titles. A DLC
 * content id 404s there, which is why DLC and bundles route via their parent.
 */
export class NsuidMapper {
  private readonly redirector: AppIdRedirector;
  private readonly customHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly defaultRegion?: string;
  private readonly timeoutMs?: number;
  private readonly retries?: number;

  constructor(options: NsuidMapperOptions = {}) {
    this.customHeaders = { ...options.headers };
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultRegion = options.defaultRegion ? normalizeRegion(options.defaultRegion) : undefined;
    this.timeoutMs = options.timeoutMs;
    this.retries = options.retries;
    this.redirector = new AppIdRedirector(options);
  }

  /** Build entry URL (no network). */
  buildUrl(appId: string, region?: string, acdIndex?: number): string {
    return this.redirector.buildUrl(appId, this.resolveRegion(region), acdIndex);
  }

  /**
   * Resolve AppID → NSUID for one region.
   *
   * Defaults to `acdIndex=0` (canonical first SKU). For Switch 2 Edition dual
   * listings, pass `acdIndex: 1` (or use {@link enumerateSkus}).
   *
   * @returns `null` when the app is not listed in that region (404 / unparseable).
   */
  async resolveAppIdToNsuid(
    appId: string,
    region?: string,
    options?: ResolveOptions,
  ): Promise<string | null> {
    const result = await this.resolveAppId(appId, region, options);
    return result?.nsuid ?? null;
  }

  /**
   * Full resolve: nsuid + path kind + raw Location.
   *
   * @returns `null` when not found / no product redirect.
   */
  async resolveAppId(
    appId: string,
    region?: string,
    options: ResolveOptions = {},
  ): Promise<AppIdResolveResult | null> {
    return this.redirector.resolveAppId(appId, this.resolveRegion(region), options);
  }

  /**
   * Enumerate all SKUs for one appId in a region by walking `acdIndex`
   * until the redirect target repeats the first (index 0) nsuid.
   *
   * Same appId can map to multiple store entries (e.g. HAC + BEE Switch 2 Edition).
   * Out-of-range acdIndex falls back to 0 server-side — that is the stop signal.
   */
  async enumerateSkus(
    appId: string,
    region?: string,
    options: EnumerateOptions = {},
  ): Promise<AppIdResolveResult[]> {
    return this.redirector.enumerateSkus(appId, this.resolveRegion(region), options);
  }

  // ── Identity: nsuid → appId ──────────────────────────────────────────────

  /**
   * Resolve an nsuid to its 16-hex application id — the reverse of
   * {@link NsuidMapper.resolveAppIdToNsuid}.
   *
   * `region` is where the product is *sold*, not where you want it: an nsuid
   * only resolves in its own catalog. Precision is not required, though — the
   * fourteen regions share four catalogs, so any country in the right group
   * works (see {@link NsuidMapper.resolveNsuidsToAppIds}).
   *
   * @returns the appId, or `null` for a kind that has none — bundles carry no
   * appId of their own, and demos and consumables have none at all.
   */
  async resolveNsuidToAppId(
    nsuid: string | number,
    region?: string,
    options?: RequestOptions,
  ): Promise<string | null> {
    const found = await this.resolveNsuidsToAppIds([nsuid], region, options);
    return found.get(parseNsuid(nsuid)) ?? null;
  }

  /**
   * Resolve many nsuids in **one** request.
   *
   * The upstream entry is batched and polymorphic, so a mixed list of titles,
   * DLC and bundles costs a single round trip and the caller does not have to
   * know the kinds up front.
   * No client-side cap is imposed, but the upstream maximum is unknown.
   * Split large lists into modest sequential batches, for example 100 IDs.
   *
   * Every nsuid asked for appears in the result. A `null` value means the kind
   * has no application id (bundle, demo, consumable) or the nsuid is not sold
   * in that region — both are answers, not failures.
   *
   * All the nsuids must belong to the same catalog. There are four, not
   * fourteen: `JP`, NOA (`US CA MX BR`), NOE (`GB DE FR ES IT NL AU NZ`) and
   * `HK`. Measured 2026-07-23 — any country in a group resolves that group's
   * nsuids, so passing `US` or `MX` is equivalent.
   */
  async resolveNsuidsToAppIds(
    nsuids: Array<string | number>,
    region?: string,
    options?: RequestOptions,
  ): Promise<Map<string, string | null>> {
    const ids = nsuids.map((n) => parseNsuid(n));
    const { country, language } = contextFor(this.resolveRegion(region));
    return fetchAppIds(ids, country, language, this.withClientTransport(options));
  }

  // ── Cross-region mapping ─────────────────────────────────────────────────

  /**
   * Map one nsuid into other regions.
   *
   * Works for `title`, `dlc` and `bundle`, each anchored on an id upstream
   * provides, and for a `demo` through its parent title. A `consumable` comes
   * back with every target unmapped and a reason — nothing lists it under a title.
   * Consumable itemId is used for bundle members, not standalone mapping.
   *
   * One nsuid per call, by design. Target countries fire together, so a batch
   * would multiply two fan-out dimensions into a burst; capped this way the
   * concurrent country count stays bounded and obvious.
   * Use {@link NsuidMapper.resolveNsuidsToAppIds} when you only need ids — that
   * one batches the input in a single request, subject to upstream capacity.
   *
   * @example
   * ```ts
   * const r = await mapper.mapNsuid('70010000095202', {
   *   from: 'JP',
   *   to: ['US', 'GB', 'HK'],
   * });
   * r.targets; // [{ region: 'US', nsuid: '70010000095203' }, …]
   * ```
   */
  async mapNsuid(nsuid: string | number, options: MapOptions): Promise<NsuidMapping> {
    const from = normalizeRegion(options.from);
    const targets = [...new Set(options.to.map(normalizeRegion))];
    // Checked after de-duplication so a list that repeats a country is not
    // rejected for a length it does not really have.
    if (targets.length > MAX_REGIONS_PER_MAP) {
      throw new TypeError(
        `mapNsuid accepts at most ${MAX_REGIONS_PER_MAP} regions per call, got ${targets.length}. ` +
          'Split the list — all target regions are issued concurrently.',
      );
    }
    if (targets.length === 0) throw new TypeError('mapNsuid needs at least one target region');

    const id = parseNsuid(nsuid);
    const { country, language } = contextFor(from);
    const requestOptions = this.withClientTransport(options);
    const identity = (await fetchIdentities([id], country, language, requestOptions)).get(id)!;

    const mapped = await Promise.all(
      targets.map((region) => mapInto(identity, region, this, requestOptions)),
    );
    return { source: { ...identity, region: from }, targets: mapped };
  }

  /** {@link AppIdResolver} — lets `mapping.ts` drive the redirector. */
  async resolve(
    appId: string,
    region: string,
    options?: RequestOptions,
  ): Promise<string | undefined> {
    const result = await this.resolveAppId(appId, region, options);
    return result?.nsuid;
  }

  private resolveRegion(region?: string): string {
    if (region != null && region !== '') return normalizeRegion(region);
    if (this.defaultRegion) return this.defaultRegion;
    throw new TypeError('region is required (or set defaultRegion on the client)');
  }

  private withClientTransport(options?: RequestOptions): RequestOptions {
    return {
      ...options,
      fetch: options?.fetch ?? this.fetchImpl,
      headers: Object.fromEntries(mergeHeaders(this.customHeaders, options?.headers)),
      timeoutMs: options?.timeoutMs ?? this.timeoutMs,
      retries: options?.retries ?? this.retries,
    };
  }
}
