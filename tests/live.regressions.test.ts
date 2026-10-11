import { expect } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { NsuidMapError } from '../src/errors.ts';
import { fetchRelatedItems } from '../src/upstreams/savanna.ts';

import { live } from './live-helper.ts';

live(
  'real redirector retries after one injected 503 and preserves both country results',
  async () => {
    let auAttempts = 0;
    const client = new NsuidMapper({
      timeoutMs: 15_000,
      fetch: (async (url, init) => {
        if (init?.method === 'GET' && String(url).endsWith('/AU')) {
          if (++auAttempts === 1) return new Response(null, { status: 503 });
        }
        // Only the first AU error is synthetic; all successful responses are live.
        return fetch(url, init);
      }) as typeof fetch,
    });
    const r = await client.mapNsuid('70010000000707', { from: 'US', to: ['AU', 'US'] });
    expect(r.targets.map((t) => t.nsuid)).toEqual(['70010000000706', '70010000000707']);
    expect(auAttempts).toBe(2);
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
  ['70070000028930', 'US', 'GB', '70070000028985'], // Just Dance: three months
  ['70070000028931', 'US', 'GB', '70070000028984'], // Just Dance: twelve months
  ['70070000028930', 'US', 'US', '70070000028930'], // Must not select Ultimate
  ['70070000013653', 'US', 'GB', '70070000013654'], // Sunbreak: multi-right DLC kit
  ['70070000027900', 'US', 'GB', '70070000028364'], // WWE Deadman
  ['70070000015109', 'US', 'GB', '70070000015108'], // Miku DLC bundle
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

const incompleteBundles = [
  ['70070000040300', 'insufficient'], // Sonic: a member currently has no ROM rights
] as const;
for (const [id, reason] of incompleteBundles) {
  live(
    `incomplete bundle identity stays unmapped: ${id}`,
    async () => {
      const result = await new NsuidMapper({ timeoutMs: 15_000 }).mapNsuid(id, {
        from: 'US',
        to: ['GB'],
      });
      expect(result.targets[0]?.nsuid).toBeUndefined();
      expect(result.targets[0]?.reason).toContain(reason);
    },
    60_000,
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
