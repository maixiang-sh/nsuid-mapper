import type { ItemKind } from './types.ts';

/** 16-hex application / title id (case-insensitive). */
const APP_ID_RE = /^[0-9a-fA-F]{16}$/;

/** 14-digit catalog nsUid. */
const CATALOG_ID_RE = /^\d{14}$/;

export function isAppId(value: string | null | undefined): boolean {
  return Boolean(value && APP_ID_RE.test(value.trim()));
}

export function parseAppId(input: string): string {
  const s = input.trim().toLowerCase();
  if (!isAppId(s)) {
    throw new TypeError(`Invalid appId: "${input}" (expect 16-hex title/application id)`);
  }
  return s;
}

/**
 * Derive the base Application ID from a DLC/AOC content Title ID.
 *
 * Nintendo allocates AOC ids in the 0x1000–0x1fff range above the base
 * application. Clearing the low 13 bits recovers the parent application id.
 */
export function deriveBaseApplicationIdFromDlcAppId(input: string): string {
  const appId = parseAppId(input);
  const value = BigInt(`0x${appId}`);
  const contentOffset = value & 0x1fffn;
  if (contentOffset < 0x1000n) {
    throw new TypeError(`AppID is not in the DLC/AOC range: "${input}"`);
  }
  return (value & ~0x1fffn).toString(16).padStart(16, '0');
}

export function isCatalogId(value: string | number): boolean {
  return CATALOG_ID_RE.test(String(value).trim());
}

/**
 * Best-effort kind hint from nsuid prefix (Nintendo convention).
 *
 * | Prefix | Hint       |
 * |--------|------------|
 * | 7001   | title      |
 * | 7003   | demo       |
 * | 7005   | dlc        |
 * | 7007   | bundle     |
 * | 7009   | consumable |
 */
export function itemKindFromNsuid(nsuid: string): ItemKind {
  switch (String(nsuid).trim().slice(0, 4)) {
    case '7001':
      return 'title';
    case '7003':
      return 'demo';
    case '7005':
      return 'dlc';
    case '7007':
      return 'bundle';
    case '7009':
      return 'consumable';
    default:
      return 'unknown';
  }
}

export function parseNsuid(input: string | number): string {
  const s = String(input).trim();
  if (!isCatalogId(s)) {
    throw new TypeError(`Invalid nsuid: "${input}" (expect 14-digit catalog id)`);
  }
  return s;
}

/** Normalize region path segment — edge expects uppercase (JP, not jp). */
export function normalizeRegion(region: string): string {
  const r = region.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(r)) {
    throw new TypeError(
      `Invalid region: "${region}" (expect ISO 3166-1 alpha-2, e.g. JP / US / HK)`,
    );
  }
  return r;
}

/** Validate the zero-based Nintendo SKU selector without silently changing it. */
export function parseAcdIndex(value: number | undefined): number {
  const index = value ?? 0;
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError('acdIndex must be a non-negative safe integer');
  }
  return index;
}
