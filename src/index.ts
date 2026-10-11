/**
 * Map a Nintendo eShop nsuid to the same product's nsuid in other regions.
 *
 * An nsuid is region-local, and there is no upstream "same product, other
 * region" API. The hop is built from two public pieces:
 *
 * 1. A minimal SKU identity query — `nsuid → 16-hex application id`.
 * 2. `https://ec.nintendo.com/apps/{appId}/{REGION}[?acdIndex=N]`, a redirector
 *    whose `Location` carries that region's nsuid.
 *
 * Titles, DLC and bundles verify platform and complete rights for SKU identity.
 * Standalone demos and consumables lack an application anchor for target
 * discovery and remain unmapped. Consumable members can participate in bundle
 * identity using their itemId and publisher ID.
 *
 * @example
 * ```ts
 * import { NsuidMapper } from '@nintendo-store/nsuid-mapper';
 *
 * const mapper = new NsuidMapper();
 * const r = await mapper.mapNsuid('70010000095202', {
 *   from: 'JP',
 *   to: ['HK', 'US', 'GB'],
 * });
 * // r.targets → [{ region: 'HK', nsuid: '70010000095206' }, …]
 * ```
 */

export { NsuidMapper, type NsuidMapperOptions } from './client.ts';
export {
  COMMON_REGIONS,
  DEFAULT_ENUMERATE_MAX,
  DEFAULT_HEADERS,
  DEFAULT_TIMEOUT_MS,
  EC_BASE,
  MAX_ENUMERATE_LIMIT,
  type CommonRegion,
} from './constants.ts';
export { NsuidMapError } from './errors.ts';
export {
  deriveBaseApplicationIdFromDlcAppId,
  isAppId,
  isCatalogId,
  isNsuid,
  itemKindFromNsuid,
  normalizeRegion,
  parseAcdIndex,
  parseAppId,
  parseNsuid,
} from './ids.ts';
export type {
  AppIdResolveResult,
  EnumerateOptions,
  ItemKind,
  ProductPathKind,
  RequestOptions,
  ResolveOptions,
} from './types.ts';
export {
  buildAppIdUrl,
  extractNsuidFromLocation,
  parseStorefrontPath,
  pathKindFromSegment,
  type BuildAppIdUrlOptions,
} from './upstreams/redirector.ts';

export {
  fetchAppIds,
  fetchIdentities,
  collectContentAppIds,
  execute,
  SAVANNA_ENDPOINT,
  SHOP_ID,
} from './upstreams/savanna.ts';
export type { Identity, IdentityKind, MappableKind } from './upstreams/savanna.ts';
export { contextFor, mapInto } from './mapping.ts';
export {
  UNMAPPABLE_COUNTRIES,
  MAPPABLE_COUNTRIES,
  MAPPABLE_COUNTRY_LANGUAGES,
  getCountryLanguageInfo,
  isCountryLanguageSupported,
  isMappable,
  isKnownMappable,
} from './catalogs.ts';
export type { CountryLanguageInfo, MappableCountry, SavannaLanguage } from './catalogs.ts';
export type { NsuidMapping, RegionMapping, AppIdResolver } from './mapping.ts';
export { MAX_REGIONS_PER_MAP } from './client.ts';
export type { MapOptions } from './client.ts';
