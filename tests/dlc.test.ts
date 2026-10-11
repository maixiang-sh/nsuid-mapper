import { expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
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
  options: { duplicateUpgrade?: boolean; truncate?: boolean; earlyEmpty?: boolean } = {},
) {
  let redirects = 0;
  const client = new NsuidMapper({
    fetch: (async (_url, init) => {
      if (init?.method !== 'POST') {
        redirects++;
        return new Response(null, {
          status: 307,
          headers: { location: '/GB/en/titles/70010000029014' },
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
    map: () => client.mapNsuid(source.nsUid, { from: 'US', to: ['GB'] }),
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
