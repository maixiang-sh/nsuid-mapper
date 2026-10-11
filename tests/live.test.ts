/**
 * Live coverage of cross-region mapping.
 *
 *   LIVE=1 bun test tests/live.test.ts
 *
 * The expected nsuids below are not this package's own output — they are the
 * per-region ids recorded independently in the Savanna client's region matrix.
 * A mapping that agrees with them was arrived at twice by different routes; one
 * that does not is wrong regardless of how confident the code looks.
 *
 * Street Fighter 6 throughout, because it ships a title, DLC, a bundle of DLC
 * and a demo under one application id — every path this package has, on one
 * game, so a failure points at the path rather than at a quirk of some title.
 *
 * Verified 2026-07-23.
 */
import { describe, expect } from 'bun:test';
import { NsuidMapper } from '../src/index.ts';
import { live } from './live-helper.ts';

const client = () => new NsuidMapper();

/** Street Fighter 6, JP. */
const JP = {
  title: '70010000095202',
  dlc: '70050000056264',
  bundle: '70070000034970',
  demo: '70030000023159',
};

/** The same products, per region — from the Savanna client's own matrix. */
const EXPECTED = {
  title: { US: '70010000095203', GB: '70010000095204', HK: '70010000095206' },
  dlc: { US: '70050000056472', GB: '70050000056271', HK: '70050000056851' },
  bundle: { US: '70070000036289', GB: '70070000036287', HK: '70070000036281' },
} as const;

const REGIONS = ['US', 'GB', 'HK'];

/** `{ US: '7001…', … }` from a mapping result, for whole-object comparison. */
function byRegion(targets: Array<{ region: string; nsuid?: string }>): Record<string, string> {
  return Object.fromEntries(
    targets.filter((t) => t.nsuid).map((t) => [t.region, t.nsuid!]),
  ) as Record<string, string>;
}

describe('mapping a title', () => {
  live(
    'resolves every region through the appId redirector',
    async () => {
      const r = await client().mapNsuid(JP.title, { from: 'JP', to: REGIONS });

      expect(r.source.kind).toBe('title');
      expect(r.source.appId).toMatch(/^[0-9a-f]{16}$/);
      expect(byRegion(r.targets)).toEqual(EXPECTED.title);
    },
    60_000,
  );
});

describe('mapping a DLC', () => {
  live(
    'finds the unique DLC under the target parent by platform and complete rights',
    async () => {
      // The parent is reached by deriving its base appId; the DLC is then picked
      // out of that parent's list by platform and full rights, never by name.
      const r = await client().mapNsuid(JP.dlc, { from: 'JP', to: REGIONS });

      expect(r.source.kind).toBe('dlc');
      expect(byRegion(r.targets)).toEqual(EXPECTED.dlc);
    },
    120_000,
  );
});

describe('mapping a bundle', () => {
  live(
    'matches complete bundle SKU identity without names',
    async () => {
      // "Year 4 Character Pass" and "Year 4 Ultimate Pass" sit on the same title
      // and read almost identically. The complete member rights distinguish
      // them; the match must be unique across discovered candidates.
      const r = await client().mapNsuid(JP.bundle, { from: 'JP', to: REGIONS });

      expect(r.source.kind).toBe('bundle');
      expect(r.source.contentAppIds?.length).toBeGreaterThan(0);
      expect(byRegion(r.targets)).toEqual(EXPECTED.bundle);
    },
    120_000,
  );

  live(
    'bundle parent anchors are sorted and unique',
    async () => {
      const r = await client().mapNsuid(JP.bundle, { from: 'JP', to: ['US'] });
      const ids = r.source.contentAppIds!;
      expect([...ids].sort()).toEqual(ids);
      expect(new Set(ids).size).toBe(ids.length);
    },
    60_000,
  );
});

describe('what cannot be mapped', () => {
  live(
    'a demo says why rather than guessing',
    async () => {
      // Upstream exposes no application id for demos. Matching one by name
      // would return a plausible wrong nsuid, which is worse than nothing.
      const r = await client().mapNsuid(JP.demo, { from: 'JP', to: REGIONS });

      expect(r.source.kind).toBe('demo');
      for (const target of r.targets) {
        expect(target.nsuid).toBeUndefined();
        expect(target.reason).toContain('no application id');
      }
    },
    60_000,
  );

  live(
    'KR and TW report the redirector limitation, not an empty result',
    async () => {
      const r = await client().mapNsuid(JP.title, { from: 'JP', to: ['KR', 'TW'] });
      for (const target of r.targets) {
        expect(target.nsuid).toBeUndefined();
        expect(target.reason).toBeTruthy();
      }
    },
    60_000,
  );

  live(
    'an nsuid absent from the source region is reported, not silently dropped',
    async () => {
      // A US nsuid does not resolve in a JP context — nsuids are region-local.
      const r = await client().mapNsuid('70010000095203', { from: 'JP', to: ['US'] });
      expect(r.source.kind).toBe('unknown');
      expect(r.source.reason).toBe(
        'The corresponding NSUID could not be resolved for this region.',
      );
      expect(r.targets[0]?.nsuid).toBeUndefined();
    },
    30_000,
  );
});

describe('batching', () => {
  live(
    'the id lookup batches; mapping deliberately does not',
    async () => {
      // `resolveNsuidsToAppIds` is polymorphic and batched — three kinds, one
      // round trip, however many ids. `mapNsuid` takes a single nsuid instead:
      // target countries fire together, so batching there would multiply two
      // fan-out dimensions into a burst.
      let identityCalls = 0;
      const fetchImpl = ((url: string | URL, init?: RequestInit) => {
        if (String(url).includes('savanna')) identityCalls++;
        return globalThis.fetch(url as string, init);
      }) as unknown as typeof fetch;

      const ids = [JP.title, JP.demo, JP.dlc];
      const found = await new NsuidMapper().resolveNsuidsToAppIds(ids, 'JP', {
        fetch: fetchImpl,
      });

      expect(identityCalls).toBe(1);
      expect([...found.keys()]).toEqual(ids);
      expect(found.get(JP.title)).toMatch(/^[0-9a-f]{16}$/);
      expect(found.get(JP.demo)).toBeNull(); // demos carry no application id
    },
    120_000,
  );

  live(
    'mapNsuid refuses more countries than the cap',
    async () => {
      const nine = ['US', 'GB', 'HK', 'CA', 'DE', 'FR', 'AU', 'NZ', 'IT'];
      const error = await client()
        .mapNsuid(JP.title, { from: 'JP', to: nine })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TypeError);
    },
    30_000,
  );
});

describe('nsuid → appId', () => {
  live(
    'resolves a batch in one request, whatever the kinds',
    async () => {
      // The reverse direction of `resolveAppIdToNsuid`. The upstream entry is
      // batched and polymorphic, so mixing kinds costs no extra round trip —
      // the guard here is the request count, not just the values.
      let requests = 0;
      const fetchImpl = ((url: string | URL, init?: RequestInit) => {
        if (String(url).includes('savanna')) requests++;
        return globalThis.fetch(url as string, init);
      }) as unknown as typeof fetch;

      const found = await client().resolveNsuidsToAppIds(
        [JP.title, JP.dlc, JP.bundle, JP.demo],
        'JP',
        { fetch: fetchImpl },
      );

      expect(requests).toBe(1);
      expect(found.get(JP.title)).toMatch(/^[0-9a-f]{16}$/);
      expect(found.get(JP.dlc)).toMatch(/^[0-9a-f]{16}$/);
      // A bundle has no appId of its own, and a demo has none at all. Both are
      // answers — every id asked for is present, with null rather than absent.
      expect(found.get(JP.bundle)).toBeNull();
      expect(found.get(JP.demo)).toBeNull();
      expect(found.size).toBe(4);
    },
    60_000,
  );

  live(
    'round-trips against the redirector',
    async () => {
      // nsuid → appId → nsuid must land back where it started.
      const mapper = client();
      const appId = await mapper.resolveNsuidToAppId(JP.title, 'JP');
      expect(appId).toBeTruthy();
      expect(await mapper.resolveAppIdToNsuid(appId!, 'JP')).toBe(JP.title);
    },
    60_000,
  );

  live(
    'any country in a catalog group resolves that group',
    async () => {
      // The fourteen regions share four catalogs. A NOA nsuid resolves under US
      // or MX alike, so callers need the group, not the exact storefront.
      const mapper = client();
      const noa = EXPECTED.title.US;
      const [viaUs, viaMx] = await Promise.all([
        mapper.resolveNsuidToAppId(noa, 'US'),
        mapper.resolveNsuidToAppId(noa, 'MX'),
      ]);
      expect(viaUs).toBeTruthy();
      expect(viaMx).toBe(viaUs);

      // ...and does not resolve outside it.
      expect(await mapper.resolveNsuidToAppId(noa, 'JP')).toBeNull();
    },
    60_000,
  );
});

describe('country coverage stays true to the redirector', () => {
  live(
    'one country per publishing region resolves, and they do not all agree',
    async () => {
      // Not an assertion that these countries *share* nsuids with their
      // neighbours — they often do, but per-title exceptions exist, which is
      // why the package never substitutes one country for another.
      const mapper = client();
      const appId = '01007ef00011e000'; // Zelda: Breath of the Wild, broad release
      const nsuids = await Promise.all(
        ['JP', 'US', 'GB', 'HK'].map((r) => mapper.resolveAppIdToNsuid(appId, r)),
      );

      for (const ns of nsuids) expect(ns).toMatch(/^\d{14}$/);
      // Four storefronts, four different listings for the same game.
      expect(new Set(nsuids).size).toBe(4);
    },
    60_000,
  );

  live(
    'a measured dead end still returns nothing',
    async () => {
      // KR redirects to a generic storefront. If that ever changes it should be
      // moved out of UNMAPPABLE_COUNTRIES, not silently left there.
      expect(await client().resolveAppIdToNsuid('01007ef00011e000', 'KR')).toBeNull();
    },
    30_000,
  );
});
