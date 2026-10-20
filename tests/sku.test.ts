import { expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { mapInto } from '../src/mapping.ts';

// Harvest Moon's verified US/GB base and Switch 2 Edition identities.
const appId = '0100839022642000';
const upgradeId = '0100839022643001';
const usBase = '70010000093554';
const usUpgrade = '70010000134284';
const gbBase = '70010000093555';
const gbUpgrade = '70010000134285';
function title(nsUid: string, upgraded: boolean) {
  return {
    __typename: 'ApplicationItem',
    nsUid,
    applications: [{ id: appId }],
    labelPlatform: upgraded ? 'BEE' : 'HAC',
    romRights: (upgraded ? [upgradeId, appId] : [appId]).map((titleId) => ({ titleId })),
    upgradeInfo: [] as Array<{
      baseApplicationItem: { nsUid: string };
      upgradeApplicationItem: { nsUid: string };
    }>,
  };
}
let targetQueries: string[] = [];
function setup(change?: (nodes: ReturnType<typeof title>[]) => void) {
  targetQueries = [];
  const nodes = [
    title(usBase, false),
    title(usUpgrade, true),
    title(gbBase, false),
    title(gbUpgrade, true),
  ];
  nodes[2]!.upgradeInfo = [
    { baseApplicationItem: { nsUid: gbBase }, upgradeApplicationItem: { nsUid: gbUpgrade } },
  ];
  change?.(nodes);
  const fetchImpl = (async (_url, init) => {
    if (init?.method !== 'POST')
      return new Response(null, { status: 307, headers: { location: `/GB/en/titles/${gbBase}` } });
    const body = JSON.parse(String(init.body)) as {
      variables: { nsUids: number[]; country: string };
      query: string;
    };
    if (body.variables.country === 'GB') targetQueries.push(body.query.match(/query (\w+)/)![1]!);
    expect(body.query).toContain('labelPlatform');
    expect(body.query).toContain('upgradeInfo');
    const requested = nodes.filter((n) => body.variables.nsUids.map(String).includes(n.nsUid));
    if (!body.query.includes('NsuidMapTitleCandidates')) {
      return Response.json({ data: { item: { itemsV2: requested } } });
    }
    // Upstream nests linked editions' full SKU identity; an absent edition is null.
    const nested = (nsUid: string) => nodes.find((n) => n.nsUid === nsUid) ?? null;
    return Response.json({
      data: {
        item: {
          itemsV2: requested.map((n) => ({
            ...n,
            upgradeInfo: n.upgradeInfo.map((link) => ({
              baseApplicationItem: nested(link.baseApplicationItem.nsUid),
              upgradeApplicationItem: nested(link.upgradeApplicationItem.nsUid),
            })),
          })),
        },
      },
    });
  }) as typeof fetch;
  return new NsuidMapper({ fetch: fetchImpl });
}
test('keeps the Switch 2 Edition and compares rights independent of order', async () => {
  const client = setup((nodes) => nodes[3]!.romRights.reverse());
  expect((await client.mapNsuid(usUpgrade, { from: 'US', to: ['GB'] })).targets[0]?.nsuid).toBe(
    gbUpgrade,
  );
  expect((await client.mapNsuid(usBase, { from: 'US', to: ['GB'] })).targets[0]?.nsuid).toBe(
    gbBase,
  );
});
test('linked editions arrive with the target title in one Savanna request', async () => {
  const client = setup();
  const result = await client.mapNsuid(usUpgrade, { from: 'US', to: ['GB'] });
  expect(result.targets[0]?.nsuid).toBe(gbUpgrade);
  expect(targetQueries).toEqual(['NsuidMapTitleCandidates']);
});
test('does not downgrade when the upgrade SKU is absent', async () => {
  const client = setup((nodes) => nodes.splice(3, 1));
  const result = await client.mapNsuid(usUpgrade, { from: 'US', to: ['GB'] });
  expect(result.targets[0]?.nsuid).toBeUndefined();
  expect(result.targets[0]?.reason).toContain('No title SKU');
  expect(result.targets[0]?.code).toBe('no_match');
});
test('a native BEE title can match the default redirect SKU', async () => {
  const client = setup((nodes) => {
    nodes[0]!.labelPlatform = 'BEE';
    nodes[2]!.labelPlatform = 'BEE';
    nodes[2]!.upgradeInfo = [];
  });
  expect((await client.mapNsuid(usBase, { from: 'US', to: ['GB'] })).targets[0]?.nsuid).toBe(
    gbBase,
  );
});
test('platform equality without matching rights is insufficient', async () => {
  const client = setup((nodes) => {
    nodes[3]!.romRights = [{ titleId: appId }];
  });
  expect(
    (await client.mapNsuid(usUpgrade, { from: 'US', to: ['GB'] })).targets[0]?.nsuid,
  ).toBeUndefined();
});
test('does not arbitrarily select between two matching SKUs', async () => {
  const client = setup((nodes) => {
    nodes[2]!.labelPlatform = 'BEE';
    nodes[2]!.romRights = nodes[3]!.romRights;
  });
  const result = await client.mapNsuid(usUpgrade, { from: 'US', to: ['GB'] });
  expect(result.targets[0]?.nsuid).toBeUndefined();
  expect(result.targets[0]?.reason).toContain('Ambiguous');
  expect(result.targets[0]?.code).toBe('ambiguous');
});
test('rejects missing source SKU evidence', async () => {
  const client = setup((nodes) => {
    nodes[1]!.romRights = [];
  });
  expect(
    (await client.mapNsuid(usUpgrade, { from: 'US', to: ['GB'] })).targets[0]?.reason,
  ).toContain('insufficient');
});

for (const missing of ['platform', 'rights'] as const) {
  test(`missing title ${missing} stops before any target request`, async () => {
    let redirects = 0;
    const r = await mapInto(
      {
        nsuid: usBase,
        kind: 'title',
        appId,
        labelPlatform: missing === 'platform' ? undefined : 'HAC',
        titleIds: missing === 'rights' ? [] : [appId],
      },
      'GB',
      {
        resolve: async () => {
          redirects++;
          throw new Error('Target network must not be called for an incomplete source');
        },
      },
    );
    expect(redirects).toBe(0);
    expect(r.nsuid).toBeUndefined();
    expect(r.reason).toContain('insufficient');
    expect(r.code).toBe('insufficient_identity');
  });
}
test('an unresolved target appId is not reported as proof that the game is unavailable', async () => {
  const r = await mapInto(
    { nsuid: usBase, kind: 'title', appId, labelPlatform: 'HAC', titleIds: [appId] },
    'GB',
    { resolve: async () => undefined },
    {
      fetch: (() => {
        throw new Error('No target NSUID to query');
      }) as unknown as typeof fetch,
    },
  );
  expect(r.nsuid).toBeUndefined();
  expect(r.reason).toContain('application ID could not be resolved');
  expect(r.code).toBe('unresolved');
  expect(r.reason).toContain('different regional application ID');
});
test('an omitted resolved target has a distinct reason from mismatching title identities', async () => {
  const r = await mapInto(
    { nsuid: usBase, kind: 'title', appId, labelPlatform: 'HAC', titleIds: [appId] },
    'GB',
    { resolve: async () => gbBase },
    {
      fetch: (async () =>
        Response.json({ data: { item: { itemsV2: [] } } })) as unknown as typeof fetch,
    },
  );
  expect(r.nsuid).toBeUndefined();
  expect(r.reason).toContain('No title identity was returned');
  expect(r.code).toBe('no_candidates');
});
test('finds upgrade DLC through upgradeInfo even when dlcItems is empty', async () => {
  const client = new NsuidMapper({
    fetch: (async (_url, init) => {
      if (init?.method !== 'POST')
        return new Response(null, {
          status: 307,
          headers: { location: `/GB/en/titles/${gbBase}` },
        });
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes('NsuidMapIdentity'))
        return Response.json({
          data: {
            item: {
              itemsV2: [
                {
                  __typename: 'DlcItem',
                  labelPlatform: 'BEE',
                  nsUid: '70050000077805',
                  romRights: [{ titleId: upgradeId }],
                },
              ],
            },
          },
        });
      expect(body.query).toContain('upgradeDlcItem');
      return Response.json({
        data: {
          item: {
            applicationItem: {
              upgradeInfo: [
                {
                  upgradeDlcItem: {
                    nsUid: '70050000078275',
                    labelPlatform: 'BEE',
                    romRights: [{ titleId: upgradeId }],
                  },
                },
              ],
              dlcItems: { items: [], offsetInfo: { total: 0 } },
            },
          },
        },
      });
    }) as typeof fetch,
  });
  expect(
    (await client.mapNsuid('70050000077805', { from: 'US', to: ['GB'] })).targets[0]?.nsuid,
  ).toBe('70050000078275');
});
