import { expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { mapInto } from '../src/mapping.ts';
import snapshot from './fixtures/dlcs.json' with { type: 'json' };

function sample(id: number) {
  const node = snapshot.items.find((n) => n.nsUid === id);
  if (!node) throw new Error(`Missing DLC fixture ${id}`);
  return structuredClone(node);
}
type Dlc = ReturnType<typeof sample>;
function setup(
  source: Dlc,
  targets: Dlc[],
  options: {
    duplicateUpgrade?: boolean;
    truncate?: boolean;
    earlyEmpty?: boolean;
    from?: string;
    parent?: string;
  } = {},
) {
  let redirects = 0;
  const client = new NsuidMapper({
    fetch: (async (_url, init) => {
      if (init?.method !== 'POST') {
        redirects++;
        return new Response(null, {
          status: 307,
          headers: { location: `/GB/en/titles/${options.parent ?? '70010000029014'}` },
        });
      }
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables: { offset: number };
      };
      if (body.query.includes('NsuidMapIdentity'))
        return Response.json({ data: { item: { itemsV2: [source] } } });
      return Response.json({
        data: {
          item: {
            applicationItem: {
              upgradeInfo: options.duplicateUpgrade ? [{ upgradeDlcItem: targets[0] }] : [],
              dlcItems: {
                items: options.earlyEmpty && body.variables.offset > 0 ? [] : targets,
                offsetInfo: {
                  total: options.truncate ? 10000 : targets.length + (options.earlyEmpty ? 1 : 0),
                },
              },
            },
          },
        },
      });
    }) as typeof fetch,
  });
  return {
    map: () => client.mapNsuid(source.nsUid, { from: options.from ?? 'US', to: ['GB'] }),
    redirects: () => redirects,
  };
}

test('DLC: all seven rights match independent of order, casing and repeated IDs', async () => {
  const target = sample(70050000023117);
  target.romRights.reverse().forEach((r) => (r.titleId = r.titleId.toUpperCase()));
  target.romRights.push({ ...target.romRights[0]! });
  const r = await setup(sample(70050000023111), [target]).map();
  expect(r.targets[0]?.nsuid).toBe(String(target.nsUid));
  expect(r.source.titleIds).toHaveLength(7);
});
test('DLC: matching the first right cannot hide a different additional right', async () => {
  const target = sample(70050000023117);
  target.romRights[1]!.titleId = '0100b04011743fff'; // Synthetic mutation.
  expect((await setup(sample(70050000023111), [target]).map()).targets[0]?.nsuid).toBeUndefined();
});
test('DLC: identical rights cannot replace a different platform', async () => {
  const target = sample(70050000023117);
  target.labelPlatform = 'BEE';
  expect((await setup(sample(70050000023111), [target]).map()).targets[0]?.nsuid).toBeUndefined();
});
test('DLC: two matching SKUs remain ambiguous', async () => {
  const a = sample(70050000023117),
    b = structuredClone(a);
  b.nsUid = 70050099999001; // Synthetic duplicate candidate.
  const r = await setup(sample(70050000023111), [a, b]).map();
  expect(r.targets[0]?.nsuid).toBeUndefined();
  expect(r.targets[0]?.reason).toContain('Ambiguous');
});
test('real shared-right DLC: all four GB products remain ambiguous for JP Part 1', async () => {
  // Actual 2026-10-11 selections; no synthetic duplicate candidate or modified rights.
  const targets = [70050000073726, 70050000073728, 70050000073729, 70050000073730].map(sample);
  const r = await setup(sample(70050000072882), targets, {
    from: 'JP',
    parent: '70010000107422',
  }).map();
  expect(r.source.titleIds).toEqual(['0400a3a01ee4d001']);
  expect(r.targets[0]?.nsuid).toBeUndefined();
  expect(r.targets[0]?.reason).toContain('Ambiguous DLC SKU');
  expect(r.targets[0]?.code).toBe('ambiguous');
  expect(r.targets[0]?.reason).toContain('cannot distinguish');
});
test('DLC: empty parent candidates have a distinct reason from identity mismatch', async () => {
  const source = sample(70050000023111);
  expect((await setup(source, []).map()).targets[0]?.reason).toContain('No DLC candidates');
  expect((await setup(source, [sample(70050000078275)]).map()).targets[0]?.reason).toContain(
    'No DLC SKU matches',
  );
});
test('DLC: the same SKU in both upgradeInfo and dlcItems is not ambiguity', async () => {
  const r = await setup(sample(70050000077805), [sample(70050000078275)], {
    duplicateUpgrade: true,
  }).map();
  expect(r.targets[0]?.nsuid).toBe('70050000078275');
});
test('DLC: missing source platform stops mapping before target requests', async () => {
  const source = sample(70050000023111);
  source.labelPlatform = '';
  const client = setup(source, [sample(70050000023117)]);
  const r = await client.map();
  expect(r.targets[0]?.reason).toContain('insufficient');
  expect(client.redirects()).toBe(0);
});
test('DLC: a match found in a truncated scan is not accepted as unique', async () => {
  const r = await setup(sample(70050000023111), [sample(70050000023117)], { truncate: true }).map();
  expect(r.targets[0]?.nsuid).toBeUndefined();
  expect(r.targets[0]?.reason).toContain('paging cap');
});

test('DLC: an early empty page cannot establish uniqueness of a real matching SKU', async () => {
  // Real seven-right identities; only the contradictory pagination is synthetic.
  const r = await setup(sample(70050000032598), [sample(70050000032599)], {
    earlyEmpty: true,
  }).map();
  expect(r.targets[0]?.nsuid).toBeUndefined();
  expect(r.targets[0]?.reason).toContain('empty page before declared total');
});

test('DLC: an unresolved parent does not prevent a complete-right match from another parent', async () => {
  // Synthetic multi-parent identity, used only to document candidate discovery policy.
  const rights = ['0100000000001001', '0200000000001001'];
  const resolved: string[] = [];
  const r = await mapInto(
    {
      nsuid: '70050099999001',
      kind: 'dlc',
      appId: rights[0],
      labelPlatform: 'HAC',
      titleIds: rights,
    },
    'GB',
    {
      resolve: async (appId) => {
        resolved.push(appId);
        return appId === '0100000000000000' ? undefined : '70010099999001';
      },
    },
    {
      fetch: (async () =>
        Response.json({
          data: {
            item: {
              applicationItem: {
                dlcItems: {
                  items: [
                    {
                      __typename: 'DlcItem',
                      nsUid: 70050099999002,
                      labelPlatform: 'HAC',
                      romRights: rights.map((titleId) => ({ titleId })),
                    },
                  ],
                  offsetInfo: { total: 1 },
                },
              },
            },
          },
        })) as unknown as typeof fetch,
    },
  );
  expect(r.nsuid).toBe('70050099999002');
  expect(resolved).toEqual(['0100000000000000', '0200000000000000']);
});
