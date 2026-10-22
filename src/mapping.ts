/**
 * Cross-region nsuid mapping.
 *
 * There is no upstream "same product, other region" API. The hop that makes it
 * possible is `ec.nintendo.com/apps/{appId}/{REGION}`, a redirector that turns a
 * 16-hex application id into that region's store URL — and the URL carries the
 * region's nsuid.
 *
 * Four kinds map, each anchored on an id upstream itself provides:
 *
 * | kind   | identity                          | target candidates                   |
 * | ------ | --------------------------------- | ----------------------------------- |
 * | title  | appId, platform and full rights   | redirector plus linked title SKUs   |
 * | dlc    | platform and full rights          | parent's DLC and upgrade list       |
 * | bundle | platform, rights and all members  | all linked parents, unique SKU      |
 * | demo   | parent title, platform, sole demo | the mapped parent title's demo list |
 *
 * Nothing here matches on names. A `consumable` carries no application id and
 * no title lists it, so it is reported unmapped rather than guessed at — a
 * wrong nsuid is worse than an honest null.
 */

import { getCountryLanguageInfo } from './catalogs.ts';
import { deriveBaseApplicationIdFromDlcAppId, normalizeRegion, parseAppId } from './ids.ts';
import type { RequestOptions } from './types.ts';
import {
  fetchRelatedItems,
  fetchTitleCandidates,
  type Identity,
  type MappingCode,
} from './upstreams/savanna.ts';

// A missing redirect does not distinguish an unavailable game from a different regional build.
const UNRESOLVED_NSUID_REASON =
  'The application ID could not be resolved in the target region; the product may be unavailable or use a different regional application ID';

/** Region → the `@inContext` pair its catalog answers in. */
export function contextFor(region: string): { country: string; language: string } {
  const country = normalizeRegion(region);
  // KR can be a source catalog even though its redirector does not map targets.
  const language =
    getCountryLanguageInfo(country)?.defaultLanguage ?? (country === 'KR' ? 'ko' : 'en');
  return { country, language };
}

/** One region's answer for one source nsuid. */
export interface RegionMapping {
  region: string;
  /** The region's nsuid, when it could be established. */
  nsuid?: string;
  /** Stable category of why the nsuid could not be established. */
  code?: MappingCode;
  /** Human-readable detail; wording may change, so branch on `code`. */
  reason?: string;
  /**
   * `ambiguous` only: every target-region NSUID of the source's kind that
   * passed matching. Absent when the conflict is elsewhere (the source title's
   * demos, or a demo's parent title); `reason` names those NSUIDs instead.
   */
  candidates?: string[];
}

function unmapped(region: string, code: MappingCode, reason: string): RegionMapping {
  return { region, code, reason };
}

/** NSUIDs listed in a `reason`; longer lists are cut so the text stays short. */
const REASON_ID_LIMIT = 5;

function listIds(ids: Iterable<string>): string {
  const all = [...new Set(ids)].sort();
  const shown = all.slice(0, REASON_ID_LIMIT).join(', ');
  return all.length > REASON_ID_LIMIT
    ? `${shown}, … and ${all.length - REASON_ID_LIMIT} more`
    : shown;
}

/** An `ambiguous` result whose target-region candidates are returned as data. */
function ambiguous(region: string, reason: string, candidates: Iterable<string>): RegionMapping {
  return { region, code: 'ambiguous', reason, candidates: [...new Set(candidates)].sort() };
}

/** A source identity's own problem, carried to every target it blocks. */
function blocked(identity: Identity, region: string, code: MappingCode, fallback: string) {
  return unmapped(region, identity.code ?? code, identity.reason ?? fallback);
}

export interface NsuidMapping {
  source: Identity & { region: string };
  targets: RegionMapping[];
}

/** Resolves an appId to a region's nsuid — the redirector half. */
export interface AppIdResolver {
  resolve(appId: string, region: string, options?: RequestOptions): Promise<string | undefined>;
}

/**
 * Map one identity into one region.
 *
 * Split out because the per-region work is independent: the caller runs these
 * concurrently, so the wall-clock cost of N regions is one region's latency,
 * not N times it.
 */
export async function mapInto(
  identity: Identity,
  region: string,
  resolver: AppIdResolver,
  options?: RequestOptions,
): Promise<RegionMapping> {
  const target = normalizeRegion(region);

  if (identity.kind === 'title') {
    const mapped = await mapTitle(identity, target, resolver, options);
    return mapped.title ? { region: target, nsuid: mapped.title.nsuid } : mapped;
  }

  if (identity.kind === 'demo' && identity.parentTitles) {
    return mapDemo(identity, target, resolver, options);
  }

  if (identity.kind === 'dlc') {
    if (!identity.appId)
      return blocked(identity, target, 'insufficient_identity', 'no application id');
    return mapDlc(identity, target, resolver, options);
  }

  if (identity.kind === 'bundle') {
    return mapBundle(identity, target, resolver, options);
  }

  return blocked(identity, target, 'unsupported', `${identity.kind} cannot be mapped`);
}

/** The matching target title keeps its identity so a demo can read the title's demo list. */
async function mapTitle(
  identity: Identity,
  target: string,
  resolver: AppIdResolver,
  options?: RequestOptions,
): Promise<RegionMapping & { title?: Identity }> {
  if (!identity.appId)
    return blocked(identity, target, 'insufficient_identity', 'no application id');
  if (!identity.labelPlatform || !identity.titleIds?.length) {
    return unmapped(target, 'insufficient_identity', 'Source title has insufficient SKU identity');
  }
  const nsuid = await resolver.resolve(identity.appId, target, options);
  if (!nsuid) return unmapped(target, 'unresolved', UNRESOLVED_NSUID_REASON);
  const { country, language } = contextFor(target);
  const candidates = await fetchTitleCandidates(nsuid, country, language, options);
  if (![...candidates.values()].some((candidate) => candidate.kind === 'title')) {
    return unmapped(
      target,
      'no_candidates',
      'No title identity was returned for the resolved target NSUID',
    );
  }
  const matches = [...candidates.values()].filter(
    (candidate) =>
      candidate.kind === 'title' &&
      candidate.appId?.toLowerCase() === identity.appId?.toLowerCase() &&
      candidate.labelPlatform === identity.labelPlatform &&
      sameSet(candidate.titleIds, identity.titleIds!),
  );
  if (matches.length === 1) return { region: target, title: matches[0] };
  return matches.length > 1
    ? ambiguous(
        target,
        `Ambiguous title SKU: ${matches.length} candidates in ${target} match the source platform and rights`,
        matches.map((match) => match.nsuid),
      )
    : unmapped(target, 'no_match', 'No title SKU matches the source platform and rights');
}

/**
 * A demo has no application id or rights, so its evidence is its parent title's
 * full identity plus being that title's only demo on the platform — on both
 * sides. A title with two same-platform demos in either region stays unmapped:
 * nothing public tells them apart.
 */
async function mapDemo(
  source: Identity,
  region: string,
  resolver: AppIdResolver,
  options?: RequestOptions,
): Promise<RegionMapping> {
  const onPlatform = (title: Identity) =>
    (title.demos ?? []).filter((demo) => demo.labelPlatform === source.labelPlatform);
  const parents = source.parentTitles!.slice(0, MAX_PARENT_TITLES);
  for (const parent of parents) {
    const demos = onPlatform(parent).map((demo) => demo.nsuid);
    if (demos.length === 1) continue;
    // These demos are in the source region, so they stay out of `candidates`.
    return unmapped(
      region,
      'ambiguous',
      demos.length
        ? `Ambiguous demo: the source title ${parent.nsuid} lists ${demos.length} demos on this platform: ${listIds(demos)}`
        : `Ambiguous demo: the source title ${parent.nsuid} lists no demo on this platform`,
    );
  }
  const found = new Set<string>();
  let failure: RegionMapping | undefined;
  for (const parent of parents) {
    const mapped = await mapTitle(parent, region, resolver, options);
    if (!mapped.title) {
      // Title candidates are not demos, so they move from `candidates` into the text.
      failure ??= mapped.candidates
        ? unmapped(
            region,
            'ambiguous',
            `Ambiguous demo: the parent title ${parent.nsuid} maps to ${mapped.candidates.length} titles in ${region}: ${listIds(mapped.candidates)}`,
          )
        : mapped;
      continue;
    }
    const demos = onPlatform(mapped.title).map((demo) => demo.nsuid);
    if (demos.length > 1) {
      return ambiguous(
        region,
        `Ambiguous demo: the target title ${mapped.title.nsuid} in ${region} lists ${demos.length} demos on this platform`,
        demos,
      );
    }
    if (demos[0]) found.add(demos[0]);
    else
      failure ??= unmapped(
        region,
        'no_candidates',
        'The target title lists no demo on the source platform',
      );
  }
  if (found.size === 1) return { region, nsuid: [...found][0] };
  if (found.size)
    return ambiguous(
      region,
      `Ambiguous demo: parent titles lead to ${found.size} different demos in ${region}`,
      found,
    );
  return failure
    ? unmapped(region, failure.code ?? 'unresolved', failure.reason ?? UNRESOLVED_NSUID_REASON)
    : unmapped(region, 'unresolved', UNRESOLVED_NSUID_REASON);
}

/** Bound distinct parent candidates and upstream upgrade links. */
const MAX_PARENT_TITLES = 16;

async function mapBundle(
  source: Identity,
  region: string,
  resolver: AppIdResolver,
  options?: RequestOptions,
): Promise<RegionMapping> {
  if (
    source.reason ||
    !source.labelPlatform ||
    !source.titleIds?.length ||
    !source.contentKeys?.length
  ) {
    return blocked(source, region, 'insufficient_identity', 'Bundle has insufficient SKU identity');
  }
  const parents = new Set<string>();
  let malformed = 0;
  let nonParent = 0;
  for (const id of source.contentAppIds ?? []) {
    try {
      const parent = parentApplicationId(id);
      if (parent) parents.add(parent);
      else nonParent++;
    } catch {
      malformed++;
    }
  }
  if (!parents.size)
    return unmapped(
      region,
      'insufficient_identity',
      `no valid parent application id (${malformed} malformed application id; ${nonParent} application id outside the base/DLC ranges)`,
    );
  if (parents.size > MAX_PARENT_TITLES)
    return unmapped(region, 'incomplete', 'Bundle parent candidate cap exceeded');

  const queue = new Set<string>();
  for (const appId of parents) {
    const parent = await resolver.resolve(appId, region, options);
    if (parent) queue.add(parent);
  }
  if (!queue.size) return unmapped(region, 'unresolved', UNRESOLVED_NSUID_REASON);
  const { country, language } = contextFor(region);
  const candidates = new Map<string, Identity>();
  let scanned = 0;
  // A Set iterator visits newly appended linked parents and deduplicates cycles.
  for (const parent of queue) {
    if (++scanned > MAX_PARENT_TITLES)
      return unmapped(region, 'incomplete', 'Bundle parent candidate cap exceeded');
    const related = await fetchRelatedItems(parent, country, language, true, options);
    if (related.truncated)
      return unmapped(
        region,
        'incomplete',
        `Bundle candidate scan incomplete (${related.incompleteReason ?? 'paging cap'})`,
      );
    for (const linked of related.upgradeNsuids) queue.add(linked);
    for (const candidate of related.bundles) candidates.set(candidate.nsuid, candidate);
  }
  if (!candidates.size) {
    return unmapped(
      region,
      'no_candidates',
      'No bundle candidates were returned for the resolved parent titles; parent listings may omit unavailable or NOT_SALE items',
    );
  }
  const matches = [...candidates.values()].filter(
    (candidate) =>
      !candidate.reason &&
      candidate.labelPlatform === source.labelPlatform &&
      sameSet(candidate.titleIds, source.titleIds!) &&
      sameSet(candidate.contentKeys, source.contentKeys!),
  );
  if (matches.length === 1) return { region, nsuid: matches[0]!.nsuid };
  return matches.length > 1
    ? ambiguous(
        region,
        `Ambiguous bundle SKU: ${matches.length} candidates in ${region} match platform, rights and contents`,
        matches.map((match) => match.nsuid),
      )
    : unmapped(
        region,
        'no_match',
        'No bundle SKU matches platform, rights and contents; unavailable or NOT_SALE items may be absent from parent listings',
      );
}

/** Compare complete DLC SKUs, including entries exposed only through upgradeInfo. */
async function mapDlc(
  source: Identity,
  region: string,
  resolver: AppIdResolver,
  options?: RequestOptions,
): Promise<RegionMapping> {
  if (!source.labelPlatform || !source.titleIds?.length) {
    return unmapped(
      region,
      'insufficient_identity',
      'Source DLC has insufficient platform or ROM rights',
    );
  }
  const parents = new Set<string>();
  for (const id of source.titleIds) {
    try {
      const parent = parentApplicationId(id);
      if (!parent)
        return unmapped(region, 'insufficient_identity', 'DLC has no valid parent application id');
      parents.add(parent);
    } catch {
      return unmapped(region, 'insufficient_identity', 'DLC has a malformed application id');
    }
  }
  if (parents.size > MAX_PARENT_TITLES)
    return unmapped(region, 'incomplete', 'DLC parent candidate cap exceeded');

  const candidates = new Map<string, Identity>();
  const visited = new Set<string>();
  const { country, language } = contextFor(region);
  for (const appId of parents) {
    const parent = await resolver.resolve(appId, region, options);
    if (!parent || visited.has(parent)) continue;
    visited.add(parent);
    const related = await fetchRelatedItems(parent, country, language, false, options);
    if (related.truncated)
      return unmapped(
        region,
        'incomplete',
        `DLC candidate scan incomplete (${related.incompleteReason ?? 'paging cap'})`,
      );
    // upgradeInfo and dlcItems can both expose the same SKU; count it only once.
    for (const candidate of related.dlcs) candidates.set(candidate.nsuid, candidate);
  }
  if (!visited.size) return unmapped(region, 'unresolved', UNRESOLVED_NSUID_REASON);
  if (!candidates.size) {
    return unmapped(
      region,
      'no_candidates',
      'No DLC candidates were returned for the resolved parent titles',
    );
  }
  const matches = [...candidates.values()].filter(
    (candidate) =>
      candidate.labelPlatform === source.labelPlatform &&
      sameSet(candidate.titleIds, source.titleIds!),
  );
  if (matches.length === 1) return { region, nsuid: matches[0]!.nsuid };
  return matches.length > 1
    ? ambiguous(
        region,
        `Ambiguous DLC SKU: ${matches.length} candidates in ${region} match platform and rights; the available identity fields cannot distinguish them`,
        matches.map((match) => match.nsuid),
      )
    : unmapped(
        region,
        'no_match',
        'No DLC SKU matches the source platform and complete ROM rights',
      );
}

/**
 * Turn one bundle/DLC content id into a parent Application id.
 *
 * Base applications are aligned to the low 13-bit boundary and are already the
 * best possible parent anchor. AOC ids occupy offsets 0x1000–0x1fff and need
 * deriving. Values in between (including update ids at 0x800) are neither.
 */
function parentApplicationId(input: string): string | undefined {
  const appId = parseAppId(input);
  const offset = BigInt(`0x${appId}`) & 0x1fffn;
  if (offset === 0n) return appId;
  if (offset >= 0x1000n) return deriveBaseApplicationIdFromDlcAppId(appId);
  return undefined;
}

/** Inputs are canonical sorted arrays; repeated member signatures remain significant. */
function sameSet(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
