import { expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { fetchRelatedItems } from '../src/upstreams/savanna.ts';
import snapshot from './fixtures/bundles.json' with { type: 'json' };

// Minimal real selections, including The Crew, FC 26 and NBA 2K26 (2026-10-11).
interface Node {
  __typename: string;
  nsUid: number;
  labelPlatform: string;
  romRights: { titleId: string }[];
  itemsV2: {
    item: {
      __typename: string;
      labelPlatform?: string;
      applications?: { id: string }[];
      romRights?: { titleId: string }[];
      itemId?: string;
      consumableItemGroup?: { id: string; publisher: { id: number } | null } | null;
    };
  }[];
}
function sample(id: number): Node {
  const node = snapshot.items.find((n) => n.nsUid === id);
  if (!node) throw new Error(`Missing bundle fixture ${id}`);
  return structuredClone(node);
}
const BASE = '70010000094233';
const UPGRADE = '70010000099190';

function setup(
  source: Node,
  targets: Node[],
  options: {
    linked?: boolean;
    split?: boolean;
    truncate?: boolean;
    earlyEmpty?: boolean;
    to?: string;
  } = {},
) {
  const to = options.to ?? 'JP';
  let gets = 0;
  const batches: number[] = [];
  const fetchImpl = (async (_url, init) => {
    if (init?.method !== 'POST') {
      gets++;
      return new Response(null, { status: 307, headers: { location: `/${to}/en/titles/${BASE}` } });
    }
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: { nsUids: number[]; nsUid: number };
    };
    expect(body.query).toContain('[PUBLIC, UNSEARCHABLE]');
    if (!body.query.includes('NsuidMapRelated')) {
      expect(body.query).toContain(
        '... on ConsumableItemV2 { itemId consumableItemGroup { publisher { id } } }',
      );
      expect(body.query).not.toContain('formalName');
    }
    if (body.query.includes('NsuidMapIdentity')) {
      return Response.json({ data: { item: { itemsV2: [source] } } });
    }
    if (body.query.includes('NsuidMapRelated')) {
      const upgraded = String(body.variables.nsUid) === UPGRADE;
      const listed = options.split
        ? targets.filter((_, i) => (upgraded ? i > 0 : i === 0))
        : options.linked
          ? targets.filter((n) => n.labelPlatform === (upgraded ? 'BEE' : 'HAC'))
          : targets;
      return Response.json({
        data: {
          item: {
            applicationItem: {
              upgradeInfo:
                options.linked || options.split
                  ? [
                      {
                        baseApplicationItem: { nsUid: BASE },
                        upgradeApplicationItem: { nsUid: UPGRADE },
                      },
                    ]
                  : [],
              includedBundleItems: listed.map((n) => ({ nsUid: n.nsUid })),
              dlcItems: {
                items: options.truncate ? [{ __typename: 'DlcItem', nsUid: 70050000000001 }] : [],
                offsetInfo: { total: options.truncate ? 10000 : options.earlyEmpty ? 1 : 0 },
              },
            },
          },
        },
      });
    }
    if (body.query.includes('NsuidMapBundleContents')) {
      batches.push(body.variables.nsUids.length);
      return Response.json({
        data: { item: { itemsV2: targets.filter((n) => body.variables.nsUids.includes(n.nsUid)) } },
      });
    }
    throw new Error('Unexpected query');
  }) as typeof fetch;
  const client = new NsuidMapper({ fetch: fetchImpl });
  return {
    map: () => client.mapNsuid(source.nsUid, { from: 'US', to: [to] }),
    gets: () => gets,
    batches,
  };
}

test('Z-A: discovers the Edition parent and never downgrades to the base bundle', async () => {
  const r = await setup(sample(70070000039411), [sample(70070000039562), sample(70070000039564)], {
    linked: true,
  }).map();
  expect(r.targets[0]?.nsuid).toBe('70070000039564');
  expect(r.source.contentAppIds).toContain('0100f43008c45001');
});

test('Z-A: an absent Edition cannot be replaced by a base bundle', async () => {
  expect(
    (await setup(sample(70070000039411), [sample(70070000039562)]).map()).targets[0]?.nsuid,
  ).toBeUndefined();
});

test('multiple exact candidates on different linked parents remain ambiguous', async () => {
  const a = sample(70070000039564),
    b = structuredClone(a);
  b.nsUid = 70070099999004; // Synthetic duplicate, not an online product.
  const r = await setup(sample(70070000039411), [a, b], { split: true }).map();
  expect(r.targets[0]?.nsuid).toBeUndefined();
  expect(r.targets[0]?.reason).toContain('Ambiguous');
});

test('Just Dance: non-searchable 3/12-month rights distinguish Deluxe and Ultimate', async () => {
  for (const [source, expected] of [
    [70070000028930, 70070000028985],
    [70070000028931, 70070000028984],
  ]) {
    const r = await setup(sample(source!), [sample(70070000028984), sample(70070000028985)]).map();
    expect(r.targets[0]?.nsuid).toBe(String(expected));
  }
});

test('Sunbreak: compares all seven kit rights independent of order and casing', async () => {
  const target = sample(70070000013654);
  for (const w of target.itemsV2)
    w.item.romRights?.reverse().forEach((r) => (r.titleId = r.titleId.toUpperCase()));
  target.itemsV2.reverse();
  const r = await setup(sample(70070000013653), [target]).map();
  expect(r.targets[0]?.nsuid).toBe('70070000013654');
  expect(r.source.contentAppIds).toHaveLength(8);
});

test('matching first kit right cannot hide a different remaining right', async () => {
  const target = sample(70070000013654);
  target.itemsV2[1]!.item.romRights![1]!.titleId = '0100b04011743fff';
  expect((await setup(sample(70070000013653), [target]).map()).targets[0]?.nsuid).toBeUndefined();
});

test('compares every application ID, including a second ID on the same member', async () => {
  const source = sample(70070000039411),
    target = sample(70070000039564);
  const second = '0100000000000000';
  source.itemsV2[0]!.item.applications!.push({ id: second });
  target.itemsV2[0]!.item.applications!.push({ id: second });
  target.itemsV2[0]!.item.applications!.reverse();
  const r = await setup(source, [target]).map();
  expect(r.source.contentAppIds).toContain(second);
  expect(r.targets[0]?.nsuid).toBe(String(target.nsUid));
  target.itemsV2[0]!.item.applications![0]!.id = '0200000000000000';
  expect((await setup(source, [target]).map()).targets[0]?.nsuid).toBeUndefined();
});

test('preserves repeated members instead of collapsing their identities into a set', async () => {
  const target = sample(70070000039564);
  target.itemsV2.push(structuredClone(target.itemsV2[1]!));
  expect((await setup(sample(70070000039411), [target]).map()).targets[0]?.nsuid).toBeUndefined();
});

test('a missing consumable itemId stops mapping before target requests', async () => {
  const source = sample(70070000033882);
  delete source.itemsV2[1]!.item.itemId;
  const client = setup(source, []);
  const r = await client.map();
  expect(r.targets[0]?.reason).toContain('insufficient itemId');
  expect(r.targets[0]?.nsuid).toBeUndefined();
  expect(client.gets()).toBe(0);
});

const crewEditions = [
  [70070000039081, 70070000040663, 70070000040657, 70070000039032],
  [70070000039083, 70070000040662, 70070000040656, 70070000039034],
  [70070000039082, 70070000040661, 70070000040654, 70070000039033],
] as const;
for (const [source, hk, jp, gb] of crewEditions) {
  test(`The Crew ${source}: consumable itemIds distinguish editions in four target countries`, async () => {
    for (const [to, column, expected] of [
      ['HK', 1, hk],
      ['JP', 2, jp],
      ['GB', 3, gb],
      ['AU', 3, gb],
    ] as const) {
      const candidates = crewEditions.map((row) => sample(row[column]));
      candidates.forEach((b) => b.itemsV2.reverse());
      const r = await setup(sample(source), candidates, { to }).map();
      expect(r.targets[0]?.nsuid).toBe(String(expected));
      expect(r.source.contentAppIds).toEqual(['0400bb40240ec000']);
    }
  });
}

test('FC 26: nine bundles with the same base, group and member count remain distinct', async () => {
  const ids = [
    70070000035280, 70070000033882, 70070000032413, 70070000028794, 70070000028790, 70070000028787,
    70070000028785, 70070000028784, 70070000028780,
  ];
  const candidates = ids.map(sample);
  for (const id of ids) {
    const result = await setup(sample(id), candidates, { to: 'US' }).map();
    expect(result.targets[0]?.nsuid).toBe(String(id));
  }
});

test('FC 26: cross-region matches use itemId and do not substitute an available different edition', async () => {
  const targets = [sample(70070000035281), sample(70070000033921)];
  for (const [source, expected] of [
    [70070000035280, '70070000035281'],
    [70070000033882, '70070000033921'],
    [70070000032413, undefined],
  ] as const) {
    const result = await setup(sample(source), targets, { to: 'GB' }).map();
    expect(result.targets[0]?.nsuid).toBe(expected);
  }
});

test('NBA 2K26: group IDs can differ while publisher and consumable itemId match', async () => {
  const source = sample(70070000030933);
  const target = sample(70070000031388);
  expect(source.itemsV2[1]!.item.consumableItemGroup!.id).not.toBe(
    target.itemsV2[1]!.item.consumableItemGroup!.id,
  );
  const result = await setup(source, [target]).map();
  expect(result.targets[0]?.nsuid).toBe('70070000031388');
});

// Mutations below are synthetic boundaries applied to verified catalog records.
test('blank itemId or missing/invalid publisher prevents using a partial consumable identity', async () => {
  for (const change of [
    (item: Node['itemsV2'][number]['item']) => {
      item.itemId = '  ';
    },
    (item: Node['itemsV2'][number]['item']) => {
      item.consumableItemGroup = null;
    },
    (item: Node['itemsV2'][number]['item']) => {
      item.consumableItemGroup!.publisher = null;
    },
    (item: Node['itemsV2'][number]['item']) => {
      item.consumableItemGroup!.publisher!.id = 0;
    },
  ]) {
    const source = sample(70070000033882);
    change(source.itemsV2[1]!.item);
    const client = setup(source, [sample(70070000033921)], { to: 'GB' });
    const result = await client.map();
    expect(result.targets[0]?.nsuid).toBeUndefined();
    expect(result.targets[0]?.reason).toContain('insufficient itemId or publisher');
    expect(client.gets()).toBe(0);
  }
});

test('a target missing consumable identity is not accepted', async () => {
  const target = sample(70070000033921);
  delete target.itemsV2[1]!.item.itemId;
  expect(
    (await setup(sample(70070000033882), [target], { to: 'GB' }).map()).targets[0]?.nsuid,
  ).toBeUndefined();
});

test('consumable itemId is opaque: case and whitespace differences are not normalized', async () => {
  for (const itemId of ['fc26futbirthdaye', 'FC26FUTBIRTHDAYE ']) {
    const target = sample(70070000033921);
    target.itemsV2[1]!.item.itemId = itemId;
    expect(
      (await setup(sample(70070000033882), [target], { to: 'GB' }).map()).targets[0]?.nsuid,
    ).toBeUndefined();
  }
});

test('a matching itemId from another publisher cannot identify the same consumable', async () => {
  const target = sample(70070000033921);
  target.itemsV2[1]!.item.consumableItemGroup!.publisher!.id = 278;
  expect(
    (await setup(sample(70070000033882), [target], { to: 'GB' }).map()).targets[0]?.nsuid,
  ).toBeUndefined();
});

test('replacing Jungle with a second Rainbow does not match Deluxe', async () => {
  const target = sample(70070000040657);
  target.itemsV2[2] = structuredClone(target.itemsV2[1]!);
  expect((await setup(sample(70070000039081), [target]).map()).targets[0]?.nsuid).toBeUndefined();
});

test('matching consumables cannot hide different base application rights', async () => {
  const target = sample(70070000033921);
  target.itemsV2[0]!.item.romRights![0]!.titleId = '0400c460219b2001';
  expect(
    (await setup(sample(70070000033882), [target], { to: 'GB' }).map()).targets[0]?.nsuid,
  ).toBeUndefined();
});

test('multiple exact consumable bundle candidates remain ambiguous', async () => {
  const a = sample(70070000033921),
    b = structuredClone(a);
  b.nsUid = 70070099999005;
  const result = await setup(sample(70070000033882), [a, b], { to: 'GB' }).map();
  expect(result.targets[0]?.nsuid).toBeUndefined();
  expect(result.targets[0]?.reason).toContain('Ambiguous');
});

test('other unsupported member types still stop mapping before target requests', async () => {
  const source = sample(70070000033882);
  source.itemsV2[1]!.item.__typename = 'DemoItem';
  const client = setup(source, []);
  const result = await client.map();
  expect(result.targets[0]?.nsuid).toBeUndefined();
  expect(result.targets[0]?.reason).toContain('unsupported member DemoItem');
  expect(client.gets()).toBe(0);
});

test('empty member rights do not produce a partial fingerprint', async () => {
  const source = sample(70070000039411);
  source.itemsV2[1]!.item.romRights = [];
  const r = await setup(source, [sample(70070000039564)]).map();
  expect(r.targets[0]?.reason).toContain('insufficient');
});

test('a paging cap prevents accepting a match from an incomplete candidate scan', async () => {
  const r = await setup(sample(70070000039411), [sample(70070000039564)], { truncate: true }).map();
  expect(r.targets[0]?.nsuid).toBeUndefined();
  expect(r.targets[0]?.reason).toContain('paging cap');
});

test('an early empty page invalidates even an included bundle with a real matching identity', async () => {
  const client = setup(sample(70070000039411), [sample(70070000039564)], { earlyEmpty: true });
  const r = await client.map();
  expect(r.targets[0]?.nsuid).toBeUndefined();
  expect(r.targets[0]?.reason).toContain('empty page before declared total');
  expect(client.batches).toEqual([]);
});

test('large candidate lists are split into batches without hiding ambiguity across batches', async () => {
  const targets = Array.from({ length: 101 }, (_, i) => {
    const target = sample(70070000039564);
    target.nsUid = 70070099999000 + i; // Synthetic duplicate candidates.
    return target;
  });
  const client = setup(sample(70070000039411), targets);
  const result = await client.map();
  expect(client.batches).toEqual([50, 50, 1]);
  expect(result.targets[0]?.nsuid).toBeUndefined();
  expect(result.targets[0]?.reason).toContain('Ambiguous');
});

test('too many distinct parents are rejected before starting target requests', async () => {
  const source = sample(70070000039411);
  source.itemsV2[0]!.item.applications = Array.from({ length: 17 }, (_, i) => ({
    id: (BigInt(i + 1) << 32n).toString(16).padStart(16, '0'),
  }));
  const client = setup(source, []);
  const result = await client.map();
  expect(result.targets[0]?.nsuid).toBeUndefined();
  expect(result.targets[0]?.reason).toContain('parent candidate cap');
  expect(client.gets()).toBe(0);
});

test('finishing on the fortieth page is complete rather than truncated', async () => {
  let calls = 0;
  const result = await fetchRelatedItems(BASE, 'JP', 'ja', false, {
    fetch: (async () => {
      calls++;
      return Response.json({
        data: {
          item: {
            applicationItem: {
              dlcItems: {
                items: Array.from({ length: 100 }, (_, i) => ({
                  nsUid: 70050099990000 + calls * 100 + i,
                })),
                offsetInfo: { total: 4000 },
              },
            },
          },
        },
      });
    }) as unknown as typeof fetch,
  });
  expect(calls).toBe(40);
  expect(result.scanned).toBe(4000);
  expect(result.truncated).toBeFalse();
});
