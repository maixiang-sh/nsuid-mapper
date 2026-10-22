import { describe, expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { mapInto } from '../src/mapping.ts';
import type { Identity } from '../src/upstreams/savanna.ts';

// Star Fox, verified live on 2026-10-14: US demo 70030000025288 → GB 70030000025302.
const APP = '0400e88025b1a000';
const US_TITLE = 70010000123167;
const GB_TITLE = 70010000123168;
const US_DEMO = 70030000025288;
const GB_DEMO = 70030000025302;

type Demo = { nsUid: number; labelPlatform: string };
function title(nsUid: number, demoItems: Demo[]) {
  return {
    __typename: 'ApplicationItem',
    nsUid,
    applications: [{ id: APP }],
    labelPlatform: 'BEE',
    romRights: [{ titleId: APP }],
    upgradeInfo: [],
    demoItems,
  };
}
const bee = (nsUid: number): Demo => ({ nsUid, labelPlatform: 'BEE' });

function setup(sourceDemos: Demo[], targetDemos: Demo[], parents = 1) {
  let targetRequests = 0;
  const client = new NsuidMapper({
    fetch: (async (_url, init) => {
      if (init?.method !== 'POST') {
        targetRequests++;
        return new Response(null, {
          status: 307,
          headers: { location: `/GB/en/titles/${GB_TITLE}` },
        });
      }
      const { query, variables } = JSON.parse(String(init.body)) as {
        query: string;
        variables: { country: string };
      };
      if (variables.country === 'GB') {
        // The target title query carries its demo list with the SKU identity.
        expect(query).toContain('NsuidMapTitleCandidates');
        expect(query).toContain('demoItems { nsUid labelPlatform }');
        targetRequests++;
        return Response.json({ data: { item: { itemsV2: [title(GB_TITLE, targetDemos)] } } });
      }
      expect(query).toContain('targetApplicationItems(salesStatuses:');
      const targetApplicationItems = Array.from({ length: parents }, () =>
        title(US_TITLE, sourceDemos),
      );
      return Response.json({
        data: {
          item: {
            itemsV2: [
              {
                __typename: 'DemoItem',
                nsUid: US_DEMO,
                labelPlatform: 'BEE',
                targetApplicationItems,
              },
            ],
          },
        },
      });
    }) as typeof fetch,
  });
  return {
    map: async () => (await client.mapNsuid(US_DEMO, { from: 'US', to: ['GB'] })).targets[0]!,
    targetRequests: () => targetRequests,
  };
}

test('demo: maps through its parent title to that title’s only demo on the platform', async () => {
  const r = await setup([bee(US_DEMO)], [bee(GB_DEMO)]).map();
  expect(r).toEqual({ region: 'GB', nsuid: String(GB_DEMO) });
});

test('demo: a demo on another platform is not a candidate', async () => {
  const other = { nsUid: 70030000099999, labelPlatform: 'HAC' };
  expect((await setup([bee(US_DEMO), other], [other, bee(GB_DEMO)]).map()).nsuid).toBe(
    String(GB_DEMO),
  );
  const r = await setup([bee(US_DEMO)], [other]).map();
  expect(r.nsuid).toBeUndefined();
  expect(r.code).toBe('no_candidates');
});

test('demo: two same-platform demos under the source title stay unmapped without target requests', async () => {
  const s = setup([bee(US_DEMO), bee(70030000099999)], [bee(GB_DEMO)]);
  const r = await s.map();
  expect(r.nsuid).toBeUndefined();
  expect(r.code).toBe('ambiguous');
  // Both demos are in the source region, so they are named in the text, not in `candidates`.
  expect(r.candidates).toBeUndefined();
  expect(r.reason).toContain(`${US_DEMO}, 70030000099999`);
  expect(s.targetRequests()).toBe(0);
});

test('demo: a source title listing no demo on the platform stops without target requests', async () => {
  const s = setup([], [bee(GB_DEMO)]);
  const r = await s.map();
  expect(r.nsuid).toBeUndefined();
  expect(r.code).toBe('insufficient_identity');
  expect(r.reason).toContain('lists no demo');
  expect(s.targetRequests()).toBe(0);
});

test('demo: a source title whose only demo is another product stops without target requests', async () => {
  // Without the reverse link, the target title's sole demo could belong to that other demo.
  const s = setup([bee(70030000099999)], [bee(GB_DEMO)]);
  const r = await s.map();
  expect(r.nsuid).toBeUndefined();
  expect(r.code).toBe('insufficient_identity');
  expect(r.reason).toContain('does not list this demo');
  expect(r.reason).toContain('70030000099999');
  expect(s.targetRequests()).toBe(0);
});

test('demo: a long list of source demos is cut in the text', async () => {
  const demos = [bee(US_DEMO), ...Array.from({ length: 6 }, (_, i) => bee(70030000099990 + i))];
  const r = await setup(demos, [bee(GB_DEMO)]).map();
  expect(r.code).toBe('ambiguous');
  expect(r.reason).toContain('7 demos');
  expect(r.reason).toContain('… and 2 more');
  expect(r.reason).not.toContain('70030000099995');
});

test('demo: two same-platform demos under the target title stay unmapped', async () => {
  const r = await setup([bee(US_DEMO)], [bee(GB_DEMO), bee(70030000099999)]).map();
  expect(r.nsuid).toBeUndefined();
  expect(r.code).toBe('ambiguous');
  expect(r.candidates).toEqual([String(GB_DEMO), '70030000099999']);
});

test('demo: without a parent title relation the source reports why', async () => {
  const s = setup([bee(US_DEMO)], [bee(GB_DEMO)], 0);
  const r = await s.map();
  expect(r.nsuid).toBeUndefined();
  expect(r.code).toBe('insufficient_identity');
  expect(s.targetRequests()).toBe(0);
});

// Synthetic two-parent demos: one demo listed under two titles with different application IDs.
describe('demo with two parent titles', () => {
  const APP_A = '0400000000010000';
  const APP_B = '0400000000020000';
  const TITLE_A = '70010099999101';
  const TITLE_B = '70010099999102';
  const SOURCE_DEMO = '70030099999001';

  function parent(appId: string, nsuid: string): Identity {
    return {
      nsuid,
      kind: 'title',
      appId,
      labelPlatform: 'BEE',
      titleIds: [appId],
      demos: [{ nsuid: SOURCE_DEMO, labelPlatform: 'BEE' }],
    };
  }
  const source: Identity = {
    nsuid: SOURCE_DEMO,
    kind: 'demo',
    labelPlatform: 'BEE',
    parentTitles: [parent(APP_A, '70010099999001'), parent(APP_B, '70010099999002')],
  };

  /** Target titles keyed by their target NSUID, each with its demo list. */
  function map(redirects: Record<string, string | undefined>, demos: Record<string, Demo[]>) {
    const appIds: Record<string, string> = { [TITLE_A]: APP_A, [TITLE_B]: APP_B };
    return mapInto(
      source,
      'GB',
      { resolve: async (appId) => redirects[appId] },
      {
        fetch: (async (_url, init) => {
          const { variables } = JSON.parse(String(init?.body)) as {
            variables: { nsUids: number[] };
          };
          const nsuid = String(variables.nsUids[0]);
          const appId = appIds[nsuid]!;
          const node = {
            ...title(Number(nsuid), demos[nsuid] ?? []),
            applications: [{ id: appId }],
          };
          return Response.json({
            data: { item: { itemsV2: [{ ...node, romRights: [{ titleId: appId }] }] } },
          });
        }) as typeof fetch,
      },
    );
  }

  test('an unresolved parent is skipped when another parent leads to the demo', async () => {
    const r = await map({ [APP_A]: undefined, [APP_B]: TITLE_B }, { [TITLE_B]: [bee(GB_DEMO)] });
    expect(r).toEqual({ region: 'GB', nsuid: String(GB_DEMO) });
  });

  test('both parents leading to the same demo is not ambiguity', async () => {
    const r = await map(
      { [APP_A]: TITLE_A, [APP_B]: TITLE_B },
      { [TITLE_A]: [bee(GB_DEMO)], [TITLE_B]: [bee(GB_DEMO)] },
    );
    expect(r.nsuid).toBe(String(GB_DEMO));
  });

  test('parents leading to different demos are ambiguous', async () => {
    const r = await map(
      { [APP_A]: TITLE_A, [APP_B]: TITLE_B },
      { [TITLE_A]: [bee(GB_DEMO)], [TITLE_B]: [bee(70030099999002)] },
    );
    expect(r.nsuid).toBeUndefined();
    expect(r.code).toBe('ambiguous');
    expect(r.candidates).toEqual([String(GB_DEMO), '70030099999002']);
  });

  test('an ambiguous parent title is named in the text, not in demo candidates', async () => {
    const twin = '70010099999103'; // Synthetic second SKU with parent A's identity.
    const r = await mapInto(
      { ...source, parentTitles: [source.parentTitles![0]!] },
      'GB',
      { resolve: async () => TITLE_A },
      {
        fetch: (async (_url, _init) => {
          const node = (nsuid: string) => ({
            ...title(Number(nsuid), [bee(GB_DEMO)]),
            applications: [{ id: APP_A }],
            romRights: [{ titleId: APP_A }],
          });
          // The twin arrives through the title's upgrade links, as linked SKUs do.
          const main = {
            ...node(TITLE_A),
            upgradeInfo: [{ baseApplicationItem: node(twin), upgradeApplicationItem: null }],
          };
          return Response.json({ data: { item: { itemsV2: [main] } } });
        }) as typeof fetch,
      },
    );
    expect(r.nsuid).toBeUndefined();
    expect(r.code).toBe('ambiguous');
    expect(r.candidates).toBeUndefined();
    expect(r.reason).toContain(`2 titles in GB: ${TITLE_A}, ${twin}`);
  });

  test('when no parent resolves, the first failure is reported', async () => {
    const r = await map({ [APP_A]: undefined, [APP_B]: undefined }, {});
    expect(r.nsuid).toBeUndefined();
    expect(r.code).toBe('unresolved');
  });
});
