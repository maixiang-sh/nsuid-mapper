import { expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';

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
      expect(query).toContain('targetApplicationItems(salesStatuses:');
      if (variables.country === 'GB') {
        targetRequests++;
        return Response.json({ data: { item: { itemsV2: [title(GB_TITLE, targetDemos)] } } });
      }
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
  expect(r.reason).toContain('no demo on the source platform');
});

test('demo: two same-platform demos under the source title stay unmapped without target requests', async () => {
  const s = setup([bee(US_DEMO), bee(70030000099999)], [bee(GB_DEMO)]);
  const r = await s.map();
  expect(r.nsuid).toBeUndefined();
  expect(r.reason).toContain('Ambiguous demo: the source title');
  expect(s.targetRequests()).toBe(0);
});

test('demo: two same-platform demos under the target title stay unmapped', async () => {
  const r = await setup([bee(US_DEMO)], [bee(GB_DEMO), bee(70030000099999)]).map();
  expect(r.nsuid).toBeUndefined();
  expect(r.reason).toContain('Ambiguous demo: the target title');
});

test('demo: without a parent title relation the source reports why', async () => {
  const s = setup([bee(US_DEMO)], [bee(GB_DEMO)], 0);
  const r = await s.map();
  expect(r.nsuid).toBeUndefined();
  expect(r.reason).toContain('no platform or parent title');
  expect(s.targetRequests()).toBe(0);
});
