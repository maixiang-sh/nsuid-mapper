import { expect } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { NsuidMapError } from '../src/errors.ts';
import { fetchRelatedItems } from '../src/upstreams/savanna.ts';

import { live } from './live-helper.ts';

live(
  'real redirector honors Retry-After after one injected 503 and preserves both country results',
  async () => {
    let auAttempts = 0;
    let failedAt = 0;
    let retriedAt = 0;
    const client = new NsuidMapper({
      timeoutMs: 15_000,
      fetch: (async (url, init) => {
        if (init?.method === 'GET' && String(url).endsWith('/AU')) {
          if (++auAttempts === 1) {
            failedAt = Date.now();
            return new Response(null, { status: 503, headers: { 'Retry-After': '1' } });
          }
          retriedAt = Date.now();
        }
        // Only the first AU error is synthetic; all successful responses are live.
        return fetch(url, init);
      }) as typeof fetch,
    });
    const r = await client.mapNsuid('70010000000707', { from: 'US', to: ['AU', 'US'] });
    expect(r.targets.map((t) => t.nsuid)).toEqual(['70010000000706', '70010000000707']);
    expect(auAttempts).toBe(2);
    expect(retriedAt - failedAt).toBeGreaterThanOrEqual(1000);
  },
  120_000,
);

live(
  'real title preflight: missing rights in a live response prevent all target requests',
  async () => {
    let gets = 0;
    const client = new NsuidMapper({
      timeoutMs: 15_000,
      fetch: (async (url, init) => {
        if (init?.method === 'GET') gets++;
        const response = await fetch(url, init);
        const input = JSON.parse(String(init?.body)) as {
          variables: { country: string };
        };
        if (input.variables.country === 'US') {
          const body = (await response.json()) as {
            data?: { item?: { itemsV2?: Array<{ nsUid: number; romRights: unknown[] }> } };
          };
          expect(response.ok).toBeTrue();
          const source = body.data?.item?.itemsV2?.find((n) => n.nsUid === 70010000000707);
          expect(source?.romRights.length).toBeGreaterThan(0);
          // The product is real; missing rights are a deliberate fault injection.
          source!.romRights = [];
          return Response.json(body);
        }
        return response;
      }) as typeof fetch,
    });
    const r = await client.mapNsuid('70010000000707', { from: 'US', to: ['AU', 'GB'] });
    expect(gets).toBe(0);
    for (const target of r.targets) {
      expect(target.nsuid).toBeUndefined();
      expect(target.reason).toContain('insufficient');
    }
  },
  60_000,
);

for (const [id, typename] of [
  ['70020000000141', 'CatalogTicketItem'],
  ['70080000001243', 'NormalTicketItem'],
] as const) {
  live(
    `real AU ticket is unsupported rather than missing: ${id}`,
    async () => {
      const r = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, {
        from: 'AU',
        to: ['GB'],
      });
      expect(r.source.reason).toBe(`Unsupported item type: ${typename}`);
      expect(r.targets[0]?.nsuid).toBeUndefined();
      expect(r.targets[0]?.reason).toBe(r.source.reason);
    },
    60_000,
  );
}

for (const withBundles of [false, true]) {
  live(
    `real JP Rise multi-page selection: bundles=${withBundles}`,
    async () => {
      const pages: Array<{ offset: number; data: Record<string, unknown> }> = [];
      const r = await fetchRelatedItems('70010000029014', 'JP', 'ja', withBundles, {
        timeoutMs: 15_000,
        fetch: (async (url, init) => {
          const response = await fetch(url, init);
          const input = JSON.parse(String(init?.body)) as {
            query: string;
            variables: { offset: number };
          };
          if (response.ok && input.query.includes('NsuidMapRelated')) {
            const body = (await response.clone().json()) as {
              data?: { item?: { applicationItem?: Record<string, unknown> } };
            };
            if (body.data?.item?.applicationItem)
              pages.push({ offset: input.variables.offset, data: body.data.item.applicationItem });
          }
          return response;
        }) as typeof fetch,
      });
      expect(r.truncated).toBeFalse();
      expect(pages.length).toBeGreaterThan(1);
      expect(r.scanned).toBeGreaterThan(100);
      expect(pages[0]?.data).toHaveProperty('upgradeInfo');
      for (const page of pages.slice(1)) {
        expect(page.offset).toBeGreaterThan(0);
        expect(page.data).not.toHaveProperty('upgradeInfo');
      }
      if (withBundles) {
        expect(r.dlcs).toEqual([]);
        expect(r.bundles.length).toBeGreaterThan(0);
        for (const page of pages) {
          const list = page.data.dlcItems as { items: Array<Record<string, unknown>> };
          for (const item of list.items.filter((n) => n.__typename === 'DlcItem')) {
            expect(item).not.toHaveProperty('romRights');
            expect(item).not.toHaveProperty('nsUid');
          }
        }
      } else {
        expect(r.dlcs.some((n) => n.titleIds?.length)).toBeTrue();
      }
    },
    120_000,
  );
}

const cases = [
  ['70010000134284', 'US', 'GB', '70010000134285'],
  ['70010000093554', 'US', 'GB', '70010000093555'],
  ['70010000116668', 'JP', 'US', '70010000116669'],
  ['70010000104365', 'GB', 'HK', '70010000104367'],
  ['70050000077805', 'US', 'GB', '70050000078275'],
  ['70050000080202', 'GB', 'GB', '70050000080202'],
] as const;
for (const [id, from, to, expected] of cases) {
  live(
    `verified SKU/upgrade mapping: ${id} ${from} → ${to}`,
    async () => {
      const result = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, { from, to: [to] });
      expect(result.targets[0]?.nsuid).toBe(expected);
    },
    60_000,
  );
}
live(
  'real response body cancellation is not a retryable network error',
  async () => {
    const controller = new AbortController();
    const client = new NsuidMapper({
      retries: 0,
      fetch: (async (url, init) => {
        const response = await fetch(url, init);
        expect(response.status).toBe(200);
        controller.abort();
        return response;
      }) as typeof fetch,
    });
    const error: unknown = await client
      .resolveNsuidsToAppIds(['70010000134284'], 'US', { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).kind).toBe('abort');
    expect((error as NsuidMapError).retryable).toBeFalse();
  },
  30_000,
);

// Targets were verified independently in Nintendo's public catalog (2026-10-11).
const bundleCases = [
  ['70070000039411', 'US', 'JP', '70070000039564'], // Pokémon Z-A Switch 2 + DLC
  ['70070000039410', 'US', 'JP', '70070000039562'], // Its Switch base bundle
  ['70070000039564', 'JP', 'US', '70070000039411'], // Reverse Edition mapping
  ['70070000040636', 'US', 'GB', '70070000040633'], // Woodo Switch 2 bundle
  ['70070000028985', 'GB', 'US', '70070000028930'], // Just Dance: three months
  ['70070000028984', 'GB', 'US', '70070000028931'], // Just Dance: twelve months
  ['70070000028930', 'US', 'US', '70070000028930'], // Must not select Ultimate
  ['70070000013653', 'US', 'GB', '70070000013654'], // Sunbreak: multi-right DLC kit
  ['70070000027900', 'US', 'GB', '70070000028364'], // WWE Deadman
  ['70070000015109', 'US', 'GB', '70070000015108'], // Miku DLC bundle
  ['70070000040300', 'US', 'GB', '70070000040301'], // Sonic: member rights present since 2026-10-14
] as const;
for (const [id, from, to, expected] of bundleCases) {
  live(
    `verified complete bundle identity: ${id} ${from} → ${to}`,
    async () => {
      const result = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, { from, to: [to] });
      expect(result.targets[0]?.nsuid).toBe(expected);
      expect(result.source.contentKeys?.length).toBeGreaterThan(0);
    },
    120_000,
  );
}

// The GB Just Dance bundles became NOT_SALE and UNSEARCHABLE by 2026-10-14. Their identities
// still equal the US ones, but parent listings cannot filter for NOT_SALE.
for (const id of ['70070000028930', '70070000028931']) {
  live(
    `a delisted target bundle is not discoverable: ${id} US → GB`,
    async () => {
      const result = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, {
        from: 'US',
        to: ['GB'],
      });
      expect(result.targets[0]?.nsuid).toBeUndefined();
      expect(result.targets[0]?.reason).toContain('No bundle SKU matches');
    },
    120_000,
  );
}

// Recorded from complete structured catalog selections, without localized text matching.
const consumableBundles = [
  [
    '70070000039081',
    { HK: '70070000040663', JP: '70070000040657', GB: '70070000039032', AU: '70070000039032' },
  ],
  [
    '70070000039083',
    { HK: '70070000040662', JP: '70070000040656', GB: '70070000039034', AU: '70070000039034' },
  ],
  [
    '70070000039082',
    { HK: '70070000040661', JP: '70070000040654', GB: '70070000039033', AU: '70070000039033' },
  ],
  [
    '70070000030933',
    { HK: '70070000031384', JP: '70070000031388', GB: '70070000031382', AU: '70070000031382' },
  ],
  ['70070000033882', { GB: '70070000033921', AU: '70070000033921' }],
  ['70070000035280', { GB: '70070000035281', AU: '70070000035281' }],
] as const;
for (const [id, expected] of consumableBundles) {
  live(
    `consumable bundle itemId mapping: ${id} US → ${Object.keys(expected).join('/')}`,
    async () => {
      const result = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, {
        from: 'US',
        to: Object.keys(expected),
      });
      expect(Object.fromEntries(result.targets.map((t) => [t.region, t.nsuid]))).toEqual(expected);
      expect(result.source.reason).toBeUndefined();
    },
    120_000,
  );
}

for (const [id, expected] of [
  ['70070000040657', '70070000039081'], // The Crew Deluxe
  ['70070000031388', '70070000030933'], // NBA: region-local consumable group
] as const) {
  live(
    `consumable bundle reverse mapping: ${id} JP → US`,
    async () => {
      const result = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, {
        from: 'JP',
        to: ['US'],
      });
      expect(result.targets[0]?.nsuid).toBe(expected);
    },
    120_000,
  );
}

live(
  'FC 26: an absent matching consumable edition is not replaced by another edition',
  async () => {
    const result = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid('70070000032413', {
      from: 'US',
      to: ['GB', 'AU'],
    });
    expect(result.source.reason).toBeUndefined();
    for (const target of result.targets) {
      expect(target.nsuid).toBeUndefined();
      expect(target.reason).toContain('No bundle SKU matches');
    }
  },
  120_000,
);

live(
  'a standalone consumable still has no parent application discovery path',
  async () => {
    const result = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid('70090000044403', {
      from: 'US',
      to: ['JP'],
    });
    expect(result.source.kind).toBe('consumable');
    expect(result.targets[0]?.nsuid).toBeUndefined();
    expect(result.targets[0]?.reason).toContain('no application id');
  },
  30_000,
);

const multiRightDlcs = [
  ['70050000023111', 'US', 'GB', '70050000023117'],
  ['70050000023117', 'GB', 'US', '70050000023111'],
  ['70050000032598', 'US', 'GB', '70050000032599'],
  ['70050000032599', 'GB', 'US', '70050000032598'],
] as const;
for (const [id, from, to, expected] of multiRightDlcs) {
  live(
    `verified seven-right DLC and per-call timeout: ${id} ${from} → ${to}`,
    async () => {
      // Override a deliberately short constructor default for both upstreams.
      const result = await new NsuidMapper({ timeoutMs: 1 }).mapNsuid(id, {
        from,
        to: [to],
        timeoutMs: 15_000,
      });
      expect(result.source.titleIds).toHaveLength(7);
      expect(result.source.labelPlatform).toBe('HAC');
      expect(result.targets[0]?.nsuid).toBe(expected);
    },
    120_000,
  );
}

// Source/target pairs checked against live names and structured identities on 2026-10-11.
// The names document the samples; mapping and assertions use no localized text.
live(
  'shared-right DLC: JP Part 1 stays ambiguous in all four target regions',
  async () => {
    const related = await fetchRelatedItems('70010000107422', 'GB', 'en', false, {
      timeoutMs: 15_000,
    });
    expect(related.truncated).toBeFalse();
    expect(related.dlcs.map((d) => d.nsuid).sort()).toEqual([
      '70050000073726',
      '70050000073728',
      '70050000073729',
      '70050000073730',
    ]);
    for (const dlc of related.dlcs) {
      expect(dlc.labelPlatform).toBe('BEE');
      expect(dlc.titleIds).toEqual(['0400a3a01ee4d001']);
    }
    const r = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid('70050000072882', {
      from: 'JP',
      to: ['US', 'GB', 'AU', 'HK'],
    });
    for (const target of r.targets) {
      expect(target.nsuid).toBeUndefined();
      expect(target.reason).toContain('Ambiguous DLC SKU');
      expect(target.reason).toContain('cannot distinguish');
    }
  },
  120_000,
);

live(
  'Anime Codex: maps western bundles and reports no returned JP candidates',
  async () => {
    const r = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid('70070000040805', {
      from: 'HK',
      to: ['JP', 'US', 'GB', 'AU'],
    });
    expect(r.source.contentKeys).toHaveLength(4);
    expect(r.targets.map((t) => t.nsuid)).toEqual([
      undefined,
      '70070000040913',
      '70070000040623',
      '70070000040623',
    ]);
    // This records current candidate discovery, not a claim that JP never sold it.
    expect(r.targets[0]?.reason).toContain('No bundle candidates');
    expect(r.targets[0]?.code).toBe('no_candidates');
  },
  120_000,
);

live(
  'Rise: JP/HK and western application IDs differ despite the game being sold in both',
  async () => {
    const client = new NsuidMapper({ timeoutMs: 15_000 });
    const r = await client.mapNsuid('70010000029014', {
      from: 'JP',
      to: ['HK', 'US', 'GB', 'AU'],
    });
    expect(r.source.appId).toBe('0100559011740000');
    expect(r.targets[0]?.nsuid).toBe('70010000029013');
    for (const target of r.targets.slice(1)) {
      expect(target.nsuid).toBeUndefined();
      expect(target.reason).toContain('different regional application ID');
    }
    expect(await client.resolveNsuidToAppId('70010000029015', 'GB')).toBe('0100b04011742000');
    expect(await client.resolveNsuidToAppId('70010000029016', 'US')).toBe('0100b04011742000');
  },
  120_000,
);

for (const [id, from, appId, expected] of [
  [
    '70010000068938',
    'US',
    '01009a401bdea000',
    { JP: null, GB: '70010000068939', AU: '70010000068939', HK: null },
  ],
  [
    '70010000070062',
    'HK',
    '01006c001c3da000',
    { JP: '70010000070063', US: null, GB: null, AU: null },
  ],
  [
    '70010000138987',
    'US',
    '01009a401bdea000',
    { JP: null, GB: '70010000138988', AU: '70010000138988', HK: null },
  ],
  [
    '70010000139338',
    'HK',
    '01006c001c3da000',
    { JP: '70010000139337', US: null, GB: null, AU: null },
  ],
] as const) {
  live(
    `Astral Ascent: regional identity ${id} is not merged with the other build`,
    async () => {
      const r = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, {
        from,
        to: Object.keys(expected),
      });
      expect(r.source.appId).toBe(appId);
      if (id === '70010000138987' || id === '70010000139338') {
        expect(r.source.labelPlatform).toBe('BEE');
      }
      expect(Object.fromEntries(r.targets.map((t) => [t.region, t.nsuid ?? null]))).toEqual(
        expected,
      );
    },
    120_000,
  );
}

for (const [id, from, expected] of [
  [
    '70070000039032',
    'GB',
    { JP: '70070000040657', US: '70070000039081', AU: '70070000039032', HK: '70070000040663' },
  ],
  [
    '70070000039032',
    'AU',
    { JP: '70070000040657', US: '70070000039081', GB: '70070000039032', HK: '70070000040663' },
  ],
  [
    '70070000039034',
    'GB',
    { JP: '70070000040656', US: '70070000039083', AU: '70070000039034', HK: '70070000040662' },
  ],
  // JP / HK resolved by 2026-10-15; same appId, platform and rights as the GB source.
  [
    '70010000045850',
    'GB',
    { JP: '70010000045848', US: '70010000045849', AU: '70010000045850', HK: '70010000045847' },
  ],
  [
    '70010000129854',
    'HK',
    { JP: '70010000129853', US: '70010000129851', GB: '70010000129852', AU: '70010000129852' },
  ],
  [
    '70010000100033',
    'GB',
    { JP: '70010000100034', US: '70010000100032', AU: '70010000100033', HK: '70010000100036' },
  ],
  [
    '70010000096856',
    'AU',
    { JP: '70010000096732', US: '70010000096855', GB: '70010000096856', HK: null },
  ],
  [
    '70010000089247',
    'JP',
    { US: '70010000089245', GB: '70010000089246', AU: '70010000089246', HK: '70010000089249' },
  ],
  [
    '70010000098299',
    'JP',
    { US: '70010000098297', GB: '70010000098298', AU: '70010000098298', HK: '70010000098301' },
  ],
  [
    '70050000036097',
    'US',
    { JP: '70050000039801', GB: '70050000036095', AU: '70050000036095', HK: null },
  ],
  [
    '70050000071472',
    'AU',
    { JP: '70050000071473', US: '70050000071468', GB: '70050000071472', HK: null },
  ],
] as const) {
  live(
    `verified multi-region mapping: ${id} from ${from}`,
    async () => {
      const r = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, {
        from,
        to: Object.keys(expected),
      });
      expect(Object.fromEntries(r.targets.map((t) => [t.region, t.nsuid ?? null]))).toEqual(
        expected,
      );
      // A free trial with a 7001 NSUID is still an ApplicationItem, not a DemoItem.
      if (id === '70010000089247' || id === '70010000098299') expect(r.source.kind).toBe('title');
    },
    120_000,
  );
}

for (const [id, from, kind, reason] of [
  ['70030000025288', 'AU', 'unknown', 'source NSUID was not returned'],
  ['70090000040108', 'AU', 'consumable', 'no application id for consumables'],
  ['70090000040109', 'AU', 'consumable', 'no application id for consumables'],
  ['70090000040457', 'AU', 'consumable', 'no application id for consumables'],
] as const) {
  live(
    `unsupported or missing source makes no target requests: ${id} ${from}`,
    async () => {
      const countries = new Set<string>();
      let redirects = 0;
      const client = new NsuidMapper({
        timeoutMs: 15_000,
        fetch: (async (url, init) => {
          if (init?.method === 'POST') {
            const input = JSON.parse(String(init.body)) as { variables: { country: string } };
            countries.add(input.variables.country);
          } else redirects++;
          return fetch(url, init);
        }) as typeof fetch,
      });
      const r = await client.mapNsuid(id, { from, to: ['JP', 'GB', 'HK'] });
      expect(r.source.kind).toBe(kind);
      expect(r.source.reason).toContain(reason);
      expect([...countries]).toEqual([from]);
      expect(redirects).toBe(0);
      for (const target of r.targets) {
        expect(target.nsuid).toBeUndefined();
        expect(target.reason).toBe(r.source.reason);
      }
    },
    60_000,
  );
}

// Demo targets checked against live names on 2026-10-14; a demo's only anchor is its title.
for (const [id, from, expected] of [
  [
    '70030000025288', // Star Fox, BEE
    'US',
    { JP: '70030000025308', GB: '70030000025302', AU: '70030000025302', HK: '70030000025297' },
  ],
  [
    '70030000025302',
    'AU',
    { JP: '70030000025308', US: '70030000025288', GB: '70030000025302', HK: '70030000025297' },
  ],
  [
    '70030000019929', // Pikmin 4, HAC
    'US',
    { JP: '70030000020003', GB: '70030000020101', AU: '70030000020101', HK: '70030000020033' },
  ],
  [
    '70030000002605', // ARMS: the HK title currently lists no demo
    'AU',
    { JP: '70030000003221', US: '70030000002523', GB: '70030000002605', HK: null },
  ],
] as const) {
  live(
    `demo maps through its parent title: ${id} from ${from}`,
    async () => {
      const r = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, {
        from,
        to: Object.keys(expected),
      });
      expect(r.source.kind).toBe('demo');
      expect(Object.fromEntries(r.targets.map((t) => [t.region, t.nsuid ?? null]))).toEqual(
        expected,
      );
    },
    120_000,
  );
}
