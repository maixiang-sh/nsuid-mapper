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
 * Demos have neither; they map through their parent title when it lists exactly
 * one demo on the platform. Standalone consumables lack any anchor for target
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

// Main entry points and their input/output types.
export {
  NsuidMapper,
  MAX_REGIONS_PER_MAP,
  type NsuidMapperOptions,
  type MapOptions,
} from './client.ts';
export { NsuidMapError } from './errors.ts';
export type { NsuidMapping, RegionMapping, AppIdResolver } from './mapping.ts';
export type { Identity, IdentityKind } from './upstreams/savanna.ts';
export {
  deriveBaseApplicationIdFromDlcAppId,
  isAppId,
  isCatalogId,
  itemKindFromNsuid,
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
export { buildAppIdUrl, type BuildAppIdUrlOptions } from './upstreams/redirector.ts';

// Advanced composition is used by consumers that handle target failures independently.
export { fetchIdentities, execute, SHOP_ID } from './upstreams/savanna.ts';
export { contextFor, mapInto } from './mapping.ts';
export { getCountryLanguageInfo, isCountryLanguageSupported, isMappable } from './catalogs.ts';
export type { CountryLanguageInfo, MappableCountry, SavannaLanguage } from './catalogs.ts';
