/**
 * Product identity: nsuid → application anchors and complete SKU evidence.
 *
 * An nsuid identifies a catalog product. Some storefronts share an nsuid;
 * others use different ones for the same product. Cross-region discovery starts
 * from application ids, then verifies the target SKU's complete identity.
 *
 * This talks to the Savanna GraphQL endpoint directly rather than depending on
 * a full Savanna client. The queries below are the whole of what this package
 * needs, including SKU and upgrade identity. Owning it keeps this adapter
 * independent of that package.
 */

import { NsuidMapError } from '../errors.ts';
import { backoffDelay, normalizeRetries, waitForRetry } from '../retry.ts';
import { normalizeTimeoutMs } from '../timeout.ts';
import type { RequestOptions } from '../types.ts';

export const SAVANNA_ENDPOINT = 'https://wb.lp1.savanna.srv.nintendo.net/graphql';

/**
 * Public client id from the eShop web frontend, with the origin it belongs to.
 *
 * The pairing is deliberate: Savanna is the backend behind `ec.nintendo.com`,
 * and the endpoint expects a browser-issued request from that origin. Sending
 * one without the other returns `UNAUTHORIZED`.
 */
const SAVANNA_CLIENT_ID = '042e4bd1f0eec144167dbc0c63f1d17876e7b9ec322713b613614214e3675df9';

const HEADERS: Record<string, string> = {
  Accept: 'application/graphql-response+json, application/json',
  'Content-Type': 'application/json',
  Origin: 'https://ec.nintendo.com',
  Referer: 'https://ec.nintendo.com/',
  'x-nintendo-savanna-client-id': SAVANNA_CLIENT_ID,
  'User-Agent':
    'Mozilla/5.0 (compatible; nintendo-store-nsuid-mapper/0.1; +https://ec.nintendo.com)',
};

/**
 * Frontend-hardcoded shop id; 3 is what `ec.nintendo.com` sends.
 *
 * Exported because a caller writing their own selection needs it as a variable
 * — there is no default, and upstream 400s without it.
 */
export const SHOP_ID = 3;

/** Shared selection: retain non-searchable contents and every member's SKU evidence. */
const BUNDLE_IDENTITY_FIELDS = `
  nsUid labelPlatform romRights { titleId }
  itemsV2(publicStatuses: [PUBLIC, UNSEARCHABLE]) {
    item {
      __typename
      ... on ApplicationItem { labelPlatform applications { id } romRights { titleId } }
      ... on DlcItem { labelPlatform romRights { titleId } }
      ... on ConsumableItemV2 { itemId consumableItemGroup { publisher { id } } }
    }
  }
`;

/**
 * One batch query covering every kind this package can map.
 *
 * `itemsV2` is polymorphic, so a mixed list of titles, DLC and bundles resolves
 * in a single round trip and the caller does not have to know a kind up front —
 * asking the wrong single-kind entry would just return null.
 *
 * Bundle identity includes platform, full rights and typed member signatures.
 * Non-searchable contents still carry rights: excluding them loses pass lengths
 * and edition bonuses. `itemsV2` nests here rather than under parent dlcItems.
 */
const Q_IDENTITY = `
query NsuidMapIdentity($shopId: Int!, $country: CountryCode!, $language: LanguageCode!, $nsUids: [NsUid!]!)
@inContext(country: $country, language: $language, shopId: $shopId) {
  item {
    itemsV2(nsUids: $nsUids) {
      __typename nsUid
      ... on ApplicationItem {
        applications { id } labelPlatform romRights { titleId }
        upgradeInfo {
          baseApplicationItem { nsUid }
          upgradeApplicationItem { nsUid }
        }
      }
      ... on DlcItem { labelPlatform romRights { titleId } }
      ... on BundleItem { ${BUNDLE_IDENTITY_FIELDS} }
    }
  }
}
`;

/**
 * Just the application id — no bundle fingerprint.
 *
 * `Q_IDENTITY` also nests a bundle's contents, which cross-region mapping needs
 * and an appId lookup never uses: bundles have no appId of their own, so that
 * whole sub-selection is fetched and discarded. `__typename` is absent too:
 * the caller wants an id, and which fragment produced it does not matter.
 * Measured 2026-07-23 on a mixed batch of four: 652 → 220 response bytes.
 */
const Q_APP_IDS = `
query NsuidMapAppIds($shopId: Int!, $country: CountryCode!, $language: LanguageCode!, $nsUids: [NsUid!]!)
@inContext(country: $country, language: $language, shopId: $shopId) {
  item {
    itemsV2(nsUids: $nsUids) {
      nsUid
      ... on ApplicationItem { applications { id } }
      ... on DlcItem { romRights { titleId } }
    }
  }
}
`;

/**
 * Resolve nsuids to application ids, and nothing else.
 *
 * Every id asked for appears in the result; `null` means the kind has none
 * (bundle, demo, consumable) or the nsuid is not sold in that catalog.
 */
export async function fetchAppIds(
  nsuids: string[],
  country: string,
  language: string,
  options?: RequestOptions & { endpoint?: string },
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (nsuids.length === 0) return out;

  const data = await execute<{ item?: { itemsV2?: Array<RawNode | null> } }>(
    Q_APP_IDS,
    { shopId: SHOP_ID, country, language, nsUids: nsuids.map(Number) },
    options,
  );

  for (const node of data.item?.itemsV2 ?? []) {
    if (!node?.nsUid) continue;
    const appId = node.applications?.[0]?.id ?? node.romRights?.[0]?.titleId;
    out.set(String(node.nsUid), appId?.trim() || null);
  }
  for (const nsuid of nsuids) if (!out.has(nsuid)) out.set(nsuid, null);
  return out;
}

/** Kinds this package can anchor to a cross-region id. */
export type MappableKind = 'title' | 'dlc' | 'bundle';
export type IdentityKind = MappableKind | 'demo' | 'consumable' | 'unknown';

export interface Identity {
  nsuid: string;
  kind: IdentityKind;
  /** 16-hex id, for `title` and `dlc`. */
  appId?: string;
  /** Title or bundle platform; appId alone is shared by base and upgraded editions. */
  labelPlatform?: string;
  /** Sorted, unique, lower-case rights for title, DLC and bundle SKU comparison. */
  titleIds?: string[];
  /** Other title SKUs explicitly linked by upstream's upgradeInfo. */
  upgradeNsuids?: string[];
  /** All bundle member application and right IDs, used only to find parent anchors. */
  contentAppIds?: string[];
  /** Sorted typed member signatures, including consumable itemId; retain duplicates. */
  contentKeys?: string[];
  /** Why this nsuid cannot be mapped, when it cannot. */
  reason?: string;
}

interface RawNode {
  __typename?: string;
  nsUid?: string | number;
  applications?: Array<{ id?: string }>;
  romRights?: Array<{ titleId?: string }>;
  labelPlatform?: string;
  itemId?: string;
  consumableItemGroup?: { publisher?: { id?: number } | null } | null;
  upgradeInfo?: Array<{
    baseApplicationItem?: { nsUid?: string | number } | null;
    upgradeApplicationItem?: { nsUid?: string | number } | null;
  }>;
  itemsV2?: Array<{ item?: RawNode }>;
}

/** Resolve identity for a batch of nsuids in their own region's context. */
export async function fetchIdentities(
  nsuids: string[],
  country: string,
  language: string,
  options?: RequestOptions & { endpoint?: string },
): Promise<Map<string, Identity>> {
  const out = new Map<string, Identity>();
  if (nsuids.length === 0) return out;

  const data = await execute<{ item?: { itemsV2?: Array<RawNode | null> } }>(
    Q_IDENTITY,
    { shopId: SHOP_ID, country, language, nsUids: nsuids.map(Number) },
    options,
  );

  for (const node of data.item?.itemsV2 ?? []) {
    if (!node?.nsUid) continue;
    const identity = toIdentity(node);
    out.set(identity.nsuid, identity);
  }

  // Upstream omits an entry entirely when the nsuid does not exist in this
  // storefront. Record that rather than leaving a silent gap in the result.
  for (const nsuid of nsuids) {
    if (!out.has(nsuid)) {
      out.set(nsuid, {
        nsuid,
        kind: 'unknown',
        reason:
          "The source NSUID was not returned by this region's catalog; it may be unavailable here or belong to another region",
      });
    }
  }
  return out;
}

function toIdentity(node: RawNode): Identity {
  const nsuid = String(node.nsUid);
  switch (node.__typename) {
    case 'ApplicationItem': {
      const appId = node.applications?.[0]?.id?.trim();
      const titleIds = [
        ...new Set(
          (node.romRights ?? [])
            .map((right) => right.titleId?.trim().toLowerCase())
            .filter((id): id is string => !!id),
        ),
      ].sort();
      const upgradeNsuids = [
        ...new Set(
          (node.upgradeInfo ?? []).flatMap((link) =>
            [link.baseApplicationItem?.nsUid, link.upgradeApplicationItem?.nsUid]
              .filter((id) => id != null)
              .map(String),
          ),
        ),
      ];
      return appId
        ? {
            nsuid,
            kind: 'title',
            appId,
            labelPlatform: node.labelPlatform,
            titleIds,
            upgradeNsuids,
          }
        : { nsuid, kind: 'title', reason: 'upstream returned no application id' };
    }
    case 'DlcItem': {
      const appId = node.romRights?.[0]?.titleId?.trim();
      return appId
        ? {
            nsuid,
            kind: 'dlc',
            appId,
            labelPlatform: node.labelPlatform,
            titleIds: normalizedIds((node.romRights ?? []).map((r) => r.titleId)),
          }
        : { nsuid, kind: 'dlc', reason: 'upstream returned no romRights title id' };
    }
    case 'BundleItem': {
      const contentAppIds = collectContentAppIds(node);
      const titleIds = normalizedIds((node.romRights ?? []).map((r) => r.titleId));
      const identity: Identity = {
        nsuid,
        kind: 'bundle',
        labelPlatform: node.labelPlatform,
        titleIds,
        contentAppIds,
      };
      if (!node.labelPlatform || !titleIds.length || !node.itemsV2?.length) {
        return { ...identity, reason: 'Bundle has insufficient platform, rights or contents' };
      }
      const contentKeys: string[] = [];
      for (const wrapper of node.itemsV2) {
        const child = wrapper?.item;
        if (child?.__typename === 'ConsumableItemV2') {
          const publisherId = child.consumableItemGroup?.publisher?.id;
          if (
            typeof child.itemId !== 'string' ||
            !child.itemId.trim() ||
            typeof publisherId !== 'number' ||
            !Number.isSafeInteger(publisherId) ||
            publisherId <= 0
          ) {
            return {
              ...identity,
              reason: 'Bundle consumable has insufficient itemId or publisher ID',
            };
          }
          // itemId is opaque and case-sensitive. Group IDs and NSUIDs can vary by region.
          // Publisher scopes the itemId; the complete bundle also constrains parent and rights.
          contentKeys.push(JSON.stringify([child.__typename, publisherId, child.itemId]));
          continue;
        }
        if (child?.__typename !== 'ApplicationItem' && child?.__typename !== 'DlcItem') {
          return {
            ...identity,
            reason: `Bundle contains unsupported member ${child?.__typename ?? 'unknown'}; no stable cross-region identity`,
          };
        }
        const apps = normalizedIds((child.applications ?? []).map((a) => a.id));
        const rights = normalizedIds((child.romRights ?? []).map((r) => r.titleId));
        if (
          !child.labelPlatform ||
          !rights.length ||
          (child.__typename === 'ApplicationItem' && !apps.length)
        ) {
          return {
            ...identity,
            reason: 'Bundle member has insufficient platform, application or ROM rights',
          };
        }
        // Region-local NSUIDs and localized names deliberately do not participate.
        contentKeys.push(JSON.stringify([child.__typename, child.labelPlatform, apps, rights]));
      }
      return { ...identity, contentKeys: contentKeys.sort() };
    }
    case 'DemoItem':
      return { nsuid, kind: 'demo', reason: 'upstream exposes no application id for demos' };
    case 'ConsumableItemV2':
      return {
        nsuid,
        kind: 'consumable',
        reason: 'upstream exposes no application id for consumables',
      };
    default:
      return { nsuid, kind: 'unknown', reason: `Unsupported item type: ${node.__typename ?? '?'}` };
  }
}

/** Parent anchors, not a SKU fingerprint: collect all member IDs without losing rights. */
export function collectContentAppIds(node: RawNode | null | undefined): string[] {
  return normalizedIds(
    (node?.itemsV2 ?? []).flatMap(({ item }) => [
      ...(item?.applications ?? []).map((a) => a.id),
      ...(item?.romRights ?? []).map((r) => r.titleId),
    ]),
  );
}

function normalizedIds(ids: Array<string | undefined>): string[] {
  return [
    ...new Set(ids.map((id) => id?.trim().toLowerCase()).filter((id): id is string => !!id)),
  ].sort();
}

/** POST a query and return `data`, normalising every failure to NsuidMapError. */
export async function execute<T>(
  query: string,
  variables: object,
  options?: RequestOptions & {
    endpoint?: string;
    /** Test seam; production callers should use the default delay. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const endpoint = options?.endpoint ?? SAVANNA_ENDPOINT;
  const timeoutMs = normalizeTimeoutMs(options?.timeoutMs);
  const retries = normalizeRetries(options?.retries);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await executeAttempt<T>(
        query,
        variables,
        endpoint,
        options,
        signal,
        timeoutSignal,
        timeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (!(error instanceof NsuidMapError) || !error.retryable || attempt === retries) throw error;
      if (signal.aborted)
        throw classifyAbort(endpoint, options?.signal, timeoutSignal, timeoutMs, error);
      try {
        await waitForRetry(backoffDelay(attempt), sleep, signal);
      } catch (sleepError) {
        if (!signal.aborted) throw sleepError;
        throw classifyAbort(endpoint, options?.signal, timeoutSignal, timeoutMs, sleepError);
      }
      if (signal.aborted)
        throw classifyAbort(endpoint, options?.signal, timeoutSignal, timeoutMs, error);
    }
  }

  throw lastError;
}

async function executeAttempt<T>(
  query: string,
  variables: object,
  endpoint: string,
  options: RequestOptions | undefined,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  const fetchFn = options?.fetch ?? globalThis.fetch;

  if (signal.aborted) {
    throw classifyAbort(endpoint, options?.signal, timeoutSignal, timeoutMs, signal.reason);
  }

  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: mergeHeaders(HEADERS, options?.headers),
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (cause) {
    if (signal.aborted) {
      throw classifyAbort(endpoint, options?.signal, timeoutSignal, timeoutMs, cause);
    }
    throw new NsuidMapError(
      `Savanna request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { url: endpoint, cause, retryable: true, kind: 'network' },
    );
  }

  if (signal.aborted) {
    // A buffered response may remain readable after cancellation; release it before failing.
    void res.body?.cancel().catch(() => {});
    throw classifyAbort(endpoint, options?.signal, timeoutSignal, timeoutMs, signal.reason);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    if (signal.aborted) {
      throw classifyAbort(endpoint, options?.signal, timeoutSignal, timeoutMs, cause);
    }
    throw new NsuidMapError(
      `Savanna response body read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        status: res.status,
        url: endpoint,
        cause,
        retryable: true,
        kind: 'network',
      },
    );
  }

  // Successful body reads also need this check: buffered data need not reject on abort.
  if (signal.aborted) {
    throw classifyAbort(endpoint, options?.signal, timeoutSignal, timeoutMs, signal.reason);
  }

  // A transient HTTP failure remains retryable regardless of its JSON envelope.
  if (res.status === 429 || res.status >= 500) {
    throw new NsuidMapError(`Savanna HTTP ${res.status}`, {
      status: res.status,
      url: endpoint,
      retryable: true,
      kind: 'http',
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new NsuidMapError(`Savanna non-JSON response (HTTP ${res.status})`, {
      status: res.status,
      url: endpoint,
      retryable: res.status === 429 || res.status >= 500,
      kind: 'response',
    });
  }

  if (
    !isRecord(json) ||
    (json.errors !== undefined && (!Array.isArray(json.errors) || !json.errors.every(isRecord)))
  ) {
    throw new NsuidMapError('Savanna response has an invalid GraphQL envelope', {
      status: res.status,
      url: endpoint,
      kind: 'response',
    });
  }
  const errors = json.errors as Array<Record<string, unknown>> | undefined;
  if (errors?.length) {
    const first = errors[0]!;
    const title = isRecord(first.extensions) ? first.extensions.title : undefined;
    // Savanna names nothing useful in an error — the title is the only signal,
    // and INVALID_PARAM covers every malformed field equally.
    throw new NsuidMapError(`Savanna GraphQL error: ${title ?? first.message ?? 'unknown'}`, {
      status: res.status,
      url: endpoint,
      kind: 'graphql',
    });
  }
  if (!res.ok) {
    throw new NsuidMapError(`Savanna HTTP ${res.status}`, {
      status: res.status,
      url: endpoint,
      retryable: res.status === 429 || res.status >= 500,
      kind: 'http',
    });
  }
  if (!isRecord(json.data)) {
    throw new NsuidMapError('Savanna response missing or invalid data', {
      status: res.status,
      url: endpoint,
      kind: 'response',
    });
  }
  return json.data as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyAbort(
  endpoint: string,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
  timeoutMs: number,
  cause: unknown,
): NsuidMapError {
  if (callerSignal?.aborted) {
    return new NsuidMapError('Savanna request aborted by caller', {
      url: endpoint,
      cause,
      kind: 'abort',
    });
  }
  if (timeoutSignal.aborted) {
    return new NsuidMapError(`Savanna request timed out after ${timeoutMs}ms`, {
      url: endpoint,
      cause,
      kind: 'timeout',
    });
  }
  return new NsuidMapError('Savanna request aborted', {
    url: endpoint,
    cause,
    kind: 'abort',
  });
}

function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) headers.set(name, value);
  }
  return headers;
}

export interface RelatedItems {
  dlcs: Identity[];
  bundles: Identity[];
  /** Base/edition parents explicitly linked by upgradeInfo. */
  upgradeNsuids: string[];
  scanned: number;
  /** True when the candidate scan stopped before reading the declared total. */
  truncated: boolean;
  incompleteReason?: 'paging cap' | 'empty page before declared total';
}

/** Upstream rejects a `limit` above this. */
const DLC_PAGE_LIMIT = 100;

/** Safety stop: 4000 related items is far past any real title. */
const MAX_RELATED_PAGES = 40;

interface RelatedResponse {
  item?: {
    applicationItem?: {
      upgradeInfo?: Array<{
        baseApplicationItem?: { nsUid?: string | number } | null;
        upgradeApplicationItem?: { nsUid?: string | number } | null;
        upgradeDlcItem?: {
          nsUid?: string | number;
          labelPlatform?: string;
          romRights?: Array<{ titleId?: string }>;
        } | null;
      }>;
      includedBundleItems?: Array<{
        nsUid?: string | number;
      }>;
      dlcItems?: {
        items?: Array<{
          __typename?: string;
          nsUid?: string | number;
          labelPlatform?: string;
          romRights?: Array<{ titleId?: string }>;
        }>;
        offsetInfo?: { total?: number };
      };
    };
  };
}

/**
 * Fetch a parent title's candidates with the ids used for exact matching.
 *
 * This function owns Savanna pagination and query shape. Mapping code only
 * decides which related item is the cross-region match.
 * DLC mode returns DLC identities, including upgrade DLC. Bundle mode returns
 * complete bundle identities and linked parents; its DLC list stays empty.
 * Both modes count every page entry, including nodes whose fields are skipped.
 */
export async function fetchRelatedItems(
  parentNsuid: string,
  country: string,
  language: string,
  wantBundleContents: boolean,
  options?: RequestOptions,
): Promise<RelatedItems> {
  const dlcs: RelatedItems['dlcs'] = [];
  const bundleNsuids = new Set<string>();
  const upgradeNsuids = new Set<string>();
  let scanned = 0;
  let offset = 0;
  let pages = 0;
  let truncated = false;
  let incompleteReason: RelatedItems['incompleteReason'];

  for (;;) {
    const data = await execute<RelatedResponse>(
      Q_RELATED,
      {
        shopId: SHOP_ID,
        country,
        language,
        nsUid: Number(parentNsuid),
        limit: DLC_PAGE_LIMIT,
        offset,
        firstPage: offset === 0,
        withBundles: wantBundleContents,
        withIncludedBundles: wantBundleContents && offset === 0,
      },
      options,
    );

    const applicationItem = data.item?.applicationItem;
    if (offset === 0) {
      for (const link of applicationItem?.upgradeInfo ?? []) {
        for (const parent of [link.baseApplicationItem, link.upgradeApplicationItem]) {
          if (parent?.nsUid) upgradeNsuids.add(String(parent.nsUid));
        }
        const dlc = link.upgradeDlcItem;
        if (!wantBundleContents && dlc?.nsUid)
          dlcs.push(toIdentity({ ...dlc, __typename: 'DlcItem' }));
      }
    }
    for (const bundle of applicationItem?.includedBundleItems ?? []) {
      if (bundle?.nsUid) bundleNsuids.add(String(bundle.nsUid));
    }

    const page = applicationItem?.dlcItems;
    const items = page?.items ?? [];
    for (const item of items) {
      if (!item?.nsUid) continue;
      if (item.__typename === 'BundleItem') bundleNsuids.add(String(item.nsUid));
      else if (!wantBundleContents) dlcs.push(toIdentity({ ...item, __typename: 'DlcItem' }));
    }

    scanned += items.length;
    offset += items.length;
    pages++;

    const total = page?.offsetInfo?.total ?? scanned;
    if (scanned >= total) break;
    if (items.length === 0) {
      // Stop requesting an empty offset, but do not claim that a partial match
      // is unique when upstream still reports unread candidates.
      truncated = true;
      incompleteReason = 'empty page before declared total';
      break;
    }
    if (pages >= MAX_RELATED_PAGES) {
      truncated = true;
      incompleteReason = 'paging cap';
      break;
    }
  }

  const bundles: RelatedItems['bundles'] = [];
  if (wantBundleContents && !truncated && bundleNsuids.size) {
    bundles.push(...(await fetchBundleFingerprints([...bundleNsuids], country, language, options)));
  }

  return { dlcs, bundles, upgradeNsuids: [...upgradeNsuids], scanned, truncated, incompleteReason };
}

/** Fetch detailed candidate identities in bounded batches. */
async function fetchBundleFingerprints(
  nsuids: string[],
  country: string,
  language: string,
  options?: RequestOptions,
): Promise<Identity[]> {
  const out: Identity[] = [];
  // Bound each detailed selection; a parent can list many large DLC bundles.
  for (let offset = 0; offset < nsuids.length; offset += 50) {
    const data = await execute<{ item?: { itemsV2?: Array<RawNode | null> } }>(
      Q_BUNDLE_CONTENTS,
      { shopId: SHOP_ID, country, language, nsUids: nsuids.slice(offset, offset + 50).map(Number) },
      options,
    );
    for (const raw of data.item?.itemsV2 ?? []) {
      if (raw?.nsUid && raw.__typename === 'BundleItem') out.push(toIdentity(raw));
    }
  }
  return out;
}

const Q_RELATED = `
query NsuidMapRelated($shopId: Int!, $country: CountryCode!, $language: LanguageCode!, $nsUid: NsUid!, $limit: Int!, $offset: Int!, $withBundles: Boolean!, $withIncludedBundles: Boolean!, $firstPage: Boolean!)
@inContext(country: $country, language: $language, shopId: $shopId) {
  item {
    applicationItem(nsUid: $nsUid) {
      upgradeInfo @include(if: $firstPage) {
        upgradeDlcItem @skip(if: $withBundles) { nsUid labelPlatform romRights { titleId } }
        baseApplicationItem @include(if: $withBundles) { nsUid }
        upgradeApplicationItem @include(if: $withBundles) { nsUid }
      }
      includedBundleItems(
        publicStatuses: [PUBLIC, UNSEARCHABLE]
        salesStatuses: [ONSALE, PRE_ORDER, SALES_TERMINATION, UNRELEASED]
      ) @include(if: $withIncludedBundles) {
        nsUid
      }
      dlcItems(
        isIncludeBundleItem: $withBundles
        limit: $limit
        offset: $offset
        salesStatuses: [ONSALE, PRE_ORDER, SALES_TERMINATION, UNRELEASED]
        publicStatuses: [PUBLIC, UNSEARCHABLE]
      ) {
        items {
          __typename @include(if: $withBundles)
          ... on DlcItem @skip(if: $withBundles) { nsUid labelPlatform romRights { titleId } }
          ... on BundleItem @include(if: $withBundles) { nsUid }
        }
        offsetInfo { total }
      }
    }
  }
}
`;

const Q_BUNDLE_CONTENTS = `
query NsuidMapBundleContents($shopId: Int!, $country: CountryCode!, $language: LanguageCode!, $nsUids: [NsUid!]!)
@inContext(country: $country, language: $language, shopId: $shopId) {
  item {
    itemsV2(nsUids: $nsUids) {
      __typename
      ... on BundleItem { ${BUNDLE_IDENTITY_FIELDS} }
    }
  }
}
`;
