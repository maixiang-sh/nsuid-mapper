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
import { USER_AGENT } from '../constants.ts';
import { mergeHeaders } from '../headers.ts';
import { parseRetryAfter } from '../retry.ts';
import { requestWithRetry } from '../request.ts';
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
  'User-Agent': USER_AGENT,
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

/** A title's SKU identity and demos, without its upgrade links. */
const TITLE_SKU_FIELDS = `
  applications { id } labelPlatform romRights { titleId }
  demoItems { nsUid labelPlatform }
`;

/**
 * A title's SKU identity, upgrade links and demos.
 *
 * Demos expose no application id or rights; the title relation is their only anchor.
 * `targetApplicationItems` rejects the query without `salesStatuses`.
 */
const TITLE_IDENTITY_FIELDS = `
  ${TITLE_SKU_FIELDS}
  upgradeInfo {
    baseApplicationItem { nsUid }
    upgradeApplicationItem { nsUid }
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
 * and edition bonuses. Parent listings select the same fields inline (`Q_RELATED`).
 */
const Q_IDENTITY = `
query NsuidMapIdentity($shopId: Int!, $country: CountryCode!, $language: LanguageCode!, $nsUids: [NsUid!]!)
@inContext(country: $country, language: $language, shopId: $shopId) {
  item {
    itemsV2(nsUids: $nsUids) {
      __typename nsUid
      ... on ApplicationItem { ${TITLE_IDENTITY_FIELDS} }
      ... on DlcItem { labelPlatform romRights { titleId } }
      ... on BundleItem { ${BUNDLE_IDENTITY_FIELDS} }
      ... on DemoItem {
        labelPlatform
        targetApplicationItems(salesStatuses: [ONSALE, PRE_ORDER, SALES_TERMINATION, UNRELEASED]) {
          nsUid ${TITLE_IDENTITY_FIELDS}
        }
      }
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

/** Identity kinds, including products without a supported cross-region mapping. */
export type IdentityKind = 'title' | 'dlc' | 'bundle' | 'demo' | 'consumable' | 'unknown';

/**
 * Stable category of why an nsuid cannot be mapped. The paired `reason` text is
 * for people and may be reworded; consumers branch on the code.
 *
 * - `source_not_found`: the source catalog did not return the source nsuid.
 * - `unsupported`: the kind (or a bundle member) has no cross-region anchor.
 * - `insufficient_identity`: upstream omitted fields the SKU identity needs.
 * - `unresolved`: the redirector found no product in the target region.
 * - `no_match`: target candidates were checked and none matched.
 * - `ambiguous`: more than one target candidate matched.
 * - `incomplete`: a candidate scan hit a cap or incomplete paging.
 */
export type MappingCode =
  | 'source_not_found'
  | 'unsupported'
  | 'insufficient_identity'
  | 'unresolved'
  | 'no_match'
  | 'ambiguous'
  | 'incomplete';

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
  /** Title only: the demos upstream lists under it. */
  demos?: Array<{ nsuid: string; labelPlatform?: string }>;
  /** Demo only: the titles upstream says it belongs to, in the demo's own region. */
  parentTitles?: Identity[];
  /** Category of why this nsuid cannot be mapped, when it cannot. */
  code?: MappingCode;
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
    baseApplicationItem?: RawNode | null;
    upgradeApplicationItem?: RawNode | null;
  }>;
  itemsV2?: Array<{ item?: RawNode }>;
  demoItems?: Array<{ nsUid?: string | number; labelPlatform?: string } | null> | null;
  targetApplicationItems?: Array<RawNode | null> | null;
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
        code: 'source_not_found',
        reason:
          "The source NSUID was not returned by this region's catalog; it may be unavailable here or belong to another region",
      });
    }
  }
  return out;
}

/**
 * A target title plus every edition its upgradeInfo links, in one round trip.
 *
 * Linked editions are nested under upgradeInfo with the same SKU fields, so a
 * title mapping does not need a second identity request for them. Checked
 * 2026-10-15 against 126 linked titles in US/GB/JP/HK: identical identities
 * to fetching the linked nsuids separately.
 */
const Q_TITLE_CANDIDATES = `
query NsuidMapTitleCandidates($shopId: Int!, $country: CountryCode!, $language: LanguageCode!, $nsUids: [NsUid!]!)
@inContext(country: $country, language: $language, shopId: $shopId) {
  item {
    itemsV2(nsUids: $nsUids) {
      __typename nsUid
      ... on ApplicationItem {
        ${TITLE_SKU_FIELDS}
        upgradeInfo {
          baseApplicationItem { nsUid ${TITLE_SKU_FIELDS} }
          upgradeApplicationItem { nsUid ${TITLE_SKU_FIELDS} }
        }
      }
    }
  }
}
`;

/**
 * Identities of a resolved target title and its linked editions.
 *
 * The map holds the requested nsuid (`kind: 'unknown'` when the catalog omits
 * it) and each linked edition upstream returned.
 */
export async function fetchTitleCandidates(
  nsuid: string,
  country: string,
  language: string,
  options?: RequestOptions & { endpoint?: string },
): Promise<Map<string, Identity>> {
  const data = await execute<{ item?: { itemsV2?: Array<RawNode | null> } }>(
    Q_TITLE_CANDIDATES,
    { shopId: SHOP_ID, country, language, nsUids: [Number(nsuid)] },
    options,
  );
  const out = new Map<string, Identity>();
  const node = (data.item?.itemsV2 ?? []).find(
    (n) => n?.nsUid != null && String(n.nsUid) === nsuid,
  );
  if (!node) {
    out.set(nsuid, {
      nsuid,
      kind: 'unknown',
      code: 'no_match',
      reason: "The NSUID was not returned by this region's catalog",
    });
    return out;
  }
  out.set(nsuid, toIdentity(node));
  for (const link of node.upgradeInfo ?? []) {
    for (const linked of [link.baseApplicationItem, link.upgradeApplicationItem]) {
      if (linked?.nsUid == null || String(linked.nsUid) === nsuid) continue;
      out.set(String(linked.nsUid), toIdentity({ ...linked, __typename: 'ApplicationItem' }));
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
            demos: (node.demoItems ?? []).flatMap((demo) =>
              demo?.nsUid ? [{ nsuid: String(demo.nsUid), labelPlatform: demo.labelPlatform }] : [],
            ),
          }
        : {
            nsuid,
            kind: 'title',
            code: 'insufficient_identity',
            reason: 'upstream returned no application id',
          };
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
        : {
            nsuid,
            kind: 'dlc',
            code: 'insufficient_identity',
            reason: 'upstream returned no romRights title id',
          };
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
        return {
          ...identity,
          code: 'insufficient_identity',
          reason: 'Bundle has insufficient platform, rights or contents',
        };
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
              code: 'insufficient_identity',
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
            code: 'unsupported',
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
            code: 'insufficient_identity',
            reason: 'Bundle member has insufficient platform, application or ROM rights',
          };
        }
        // Region-local NSUIDs and localized names deliberately do not participate.
        contentKeys.push(JSON.stringify([child.__typename, child.labelPlatform, apps, rights]));
      }
      return { ...identity, contentKeys: contentKeys.sort() };
    }
    case 'DemoItem': {
      const parentTitles = (node.targetApplicationItems ?? []).flatMap((title) =>
        title?.nsUid ? [toIdentity({ ...title, __typename: 'ApplicationItem' })] : [],
      );
      return node.labelPlatform && parentTitles.length
        ? { nsuid, kind: 'demo', labelPlatform: node.labelPlatform, parentTitles }
        : {
            nsuid,
            kind: 'demo',
            code: 'insufficient_identity',
            reason: 'upstream returned no platform or parent title for demo',
          };
    }
    case 'ConsumableItemV2':
      return {
        nsuid,
        kind: 'consumable',
        code: 'unsupported',
        reason: 'upstream exposes no application id for consumables',
      };
    default:
      return {
        nsuid,
        kind: 'unknown',
        code: 'unsupported',
        reason: `Unsupported item type: ${node.__typename ?? '?'}`,
      };
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
  return requestWithRetry({
    url: endpoint,
    label: 'Savanna',
    init: {
      method: 'POST',
      headers: mergeHeaders(HEADERS, options?.headers),
      body: JSON.stringify({ query, variables }),
    },
    options,
    readResponse: (response) => readGraphqlResponse<T>(response, endpoint),
  });
}

async function readGraphqlResponse<T>(res: Response, endpoint: string): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch (cause) {
    throw new NsuidMapError(
      `Savanna response body read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        status: res.status,
        url: endpoint,
        cause,
        retryable: true,
        kind: 'network',
        retryAfterMs:
          res.status === 429 || res.status >= 500
            ? parseRetryAfter(res.headers.get('Retry-After'))
            : undefined,
      },
    );
  }

  // A transient HTTP failure remains retryable regardless of its JSON envelope.
  if (res.status === 429 || res.status >= 500) {
    throw new NsuidMapError(`Savanna HTTP ${res.status}`, {
      status: res.status,
      url: endpoint,
      retryable: true,
      kind: 'http',
      retryAfterMs: parseRetryAfter(res.headers.get('Retry-After')),
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
      includedBundleItems?: Array<RawNode | null>;
      dlcItems?: {
        items?: Array<RawNode | null>;
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
 *
 * Bundle identities arrive inline with each page rather than from a second
 * batch query. Checked 2026-10-15 against 679 bundles under 242 parents in
 * US/GB/JP/HK, multi-page parents included: identical identities, about half
 * the requests and slightly fewer response bytes, since bundle ids are no
 * longer sent twice.
 */
export async function fetchRelatedItems(
  parentNsuid: string,
  country: string,
  language: string,
  wantBundleContents: boolean,
  options?: RequestOptions,
): Promise<RelatedItems> {
  const dlcs: RelatedItems['dlcs'] = [];
  // Keyed by nsuid: a bundle can be both included and listed among the DLC.
  const bundles = new Map<string, Identity>();
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
      if (bundle?.nsUid) {
        bundles.set(String(bundle.nsUid), toIdentity({ ...bundle, __typename: 'BundleItem' }));
      }
    }

    const page = applicationItem?.dlcItems;
    const items = page?.items ?? [];
    for (const item of items) {
      if (!item?.nsUid) continue;
      if (item.__typename === 'BundleItem') bundles.set(String(item.nsUid), toIdentity(item));
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

  return {
    dlcs,
    // A partial scan cannot establish a unique candidate, so it returns none.
    bundles: wantBundleContents && !truncated ? [...bundles.values()] : [],
    upgradeNsuids: [...upgradeNsuids],
    scanned,
    truncated,
    incompleteReason,
  };
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
        ${BUNDLE_IDENTITY_FIELDS}
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
          ... on BundleItem @include(if: $withBundles) { ${BUNDLE_IDENTITY_FIELDS} }
        }
        offsetInfo { total }
      }
    }
  }
}
`;
