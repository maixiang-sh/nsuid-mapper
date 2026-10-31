import { expect, test } from 'bun:test';
import { NsuidMapper, NsuidMapError } from '../src/index.ts';
import recordings from './fixtures/time-tickets.json' with { type: 'json' };

interface Ticket {
  __typename?: string;
  nsUid?: string | number;
  ticketItemGroupId?: string | null;
  grantMinutes?: number | null;
  subscriptionTicketItem?: Ticket | null;
  ticketItemGroup?: Group | null;
}
interface Group {
  id?: string | null;
  publisher?: { id?: number | null } | null;
  ticketItemsV2?: Array<Ticket | null> | null;
}

function source(id = '70080000002063'): Ticket {
  const sample = recordings.samples.find((s) => String(s.request.variables.nsUids?.[0]) === id);
  if (!sample) throw new Error(`Missing source recording ${id}`);
  return structuredClone(sample.response.data.item.itemsV2![0]!) as Ticket;
}

function group(country = 'US', id = '47c8fdb7cec2769c'): Group {
  const sample = recordings.samples.find(
    (s) => s.request.variables.country === country && s.request.variables.ticketItemGroupId === id,
  );
  if (!sample) throw new Error(`Missing group recording ${country}/${id}`);
  return structuredClone(sample.response.data.item.ticketItemGroup!) as Group;
}

function setup(
  node = source(),
  groups: Record<string, Group | null> = { US: group() },
  from = 'HK',
) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new NsuidMapper({
    retries: 0,
    fetch: (async (_url, init) => {
      // Time tickets never use the redirector.
      expect(init?.method).toBe('POST');
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      if (request.query.includes('NsuidMapIdentity')) {
        expect(request.variables.country).toBe(from);
        expect(request.query).toContain('... on NormalTicketItem');
        expect(request.query).toContain('ticketItemsV2(publicStatuses: [PUBLIC, UNSEARCHABLE])');
        return Response.json({ data: { item: { itemsV2: [node] } } });
      }
      expect(request.query).toContain('NsuidMapTimeTicketGroup');
      expect(request.variables.ticketItemGroupId).toBe(node.ticketItemGroupId);
      const country = request.variables.country;
      if (!(country in groups)) throw new Error(`Unexpected target request ${country}`);
      return Response.json({ data: { item: { ticketItemGroup: groups[country] } } });
    }) as typeof fetch,
  });
  return {
    requests,
    map: (to = ['US']) => client.mapNsuid(String(node.nsUid), { from, to }),
  };
}

test('recorded VIP year pass maps HK → US/GB using exact minutes and group identity', async () => {
  const s = setup(source(), { US: group(), GB: group('GB') });
  const result = await s.map(['US', 'GB']);
  expect(result.source.kind).toBe('ticket');
  expect(result.source.ticket).toEqual({
    groupId: '47c8fdb7cec2769c',
    publisherId: 368,
    grantMinutes: 525600,
    subscriptionMinutes: null,
  });
  expect(result.targets).toEqual([
    { region: 'US', nsuid: '70080000002054' },
    { region: 'GB', nsuid: '70080000002066' },
  ]);
  expect(s.requests).toHaveLength(3);
});

test('recorded ordinary ticket with a subscription relation maps by minutes, not subscription NSUID', async () => {
  const s = setup(source('70080000001243'), { US: group('US', '21c207bbdc439909') }, 'AU');
  const result = await s.map();
  expect(result.source.ticket?.subscriptionMinutes).toBe(43200);
  expect(result.targets[0]).toEqual({ region: 'US', nsuid: '70080000001247' });
});

test('recorded same-duration source SKUs remain ambiguous before any target request', async () => {
  const s = setup(source('70080000002057'));
  const result = await s.map(['US', 'GB']);
  expect(result.source.code).toBe('ambiguous');
  for (const target of result.targets) {
    expect(target.code).toBe('ambiguous');
    expect(target.nsuid).toBeUndefined();
    // Source-region conflicts are not target candidates.
    expect(target.candidates).toBeUndefined();
  }
  expect(s.requests).toHaveLength(1);
});

test('multiple distinct target matches return every candidate sorted, without choosing one', async () => {
  const target = group();
  const match = target.ticketItemsV2!.find((ticket) => ticket?.grantMinutes === 525600)!;
  const twin = { ...match, nsUid: '70080000000001' }; // Synthetic second SKU.
  target.ticketItemsV2!.push(twin, structuredClone(match));
  const result = (await setup(source(), { US: target }).map()).targets[0]!;
  expect(result.code).toBe('ambiguous');
  expect(result.nsuid).toBeUndefined();
  expect(result.candidates).toEqual(['70080000000001', '70080000002054']);
});

test('repeated appearances of the same source or target SKU are not ambiguity', async () => {
  const node = source();
  node.ticketItemGroup!.ticketItemsV2!.push(
    structuredClone(node.ticketItemGroup!.ticketItemsV2!.at(-1)!),
  );
  const target = group();
  target.ticketItemsV2!.push(structuredClone(target.ticketItemsV2!.at(-1)!));
  expect((await setup(node, { US: target }).map()).targets[0]?.nsuid).toBe('70080000002054');
});

for (const [label, mutate] of [
  [
    'different group',
    (g: Group) => {
      g.id = 'another-group';
      for (const t of g.ticketItemsV2!) t!.ticketItemGroupId = g.id;
    },
  ],
  [
    'different publisher',
    (g: Group) => {
      g.publisher!.id = 999;
    },
  ],
  [
    'different exact minutes',
    (g: Group) => {
      for (const t of g.ticketItemsV2!) t!.grantMinutes = 525599;
    },
  ],
  [
    'subscription present instead of null',
    (g: Group) => {
      for (const t of g.ticketItemsV2!)
        t!.subscriptionTicketItem = {
          __typename: 'NormalSubscriptionTicketItem',
          nsUid: '70080099999999',
          grantMinutes: 525600,
        };
    },
  ],
] as const) {
  test(`time ticket does not match ${label}`, async () => {
    const target = group();
    mutate(target);
    const result = (await setup(source(), { US: target }).map()).targets[0]!;
    expect(result.code).toBe('no_match');
    expect(result.nsuid).toBeUndefined();
  });
}

test('subscription relation minutes must match even when the ordinary ticket duration matches', async () => {
  const target = group('US', '21c207bbdc439909');
  target.ticketItemsV2!.find(
    (t) => t?.grantMinutes === 43200,
  )!.subscriptionTicketItem!.grantMinutes = 10080;
  const result = await setup(source('70080000001243'), { US: target }, 'AU').map();
  expect(result.targets[0]?.code).toBe('no_match');
});

for (const [label, mutate] of [
  [
    'missing group',
    (n: Ticket) => {
      n.ticketItemGroup = null;
    },
  ],
  [
    'different declared group ID',
    (n: Ticket) => {
      n.ticketItemGroupId = 'wrong-group';
    },
  ],
  [
    'missing publisher',
    (n: Ticket) => {
      n.ticketItemGroup!.publisher = null;
    },
  ],
  [
    'missing source membership',
    (n: Ticket) => {
      n.ticketItemGroup!.ticketItemsV2 = [];
    },
  ],
  [
    'contradictory source membership',
    (n: Ticket) => {
      n.ticketItemGroup!.ticketItemsV2!.at(-1)!.grantMinutes = 525599;
    },
  ],
  [
    'missing subscription relation',
    (n: Ticket) => {
      delete n.subscriptionTicketItem;
    },
  ],
  [
    'unknown subscription type',
    (n: Ticket) => {
      n.subscriptionTicketItem = {
        __typename: 'UnknownTicket',
        nsUid: '70080099999999',
        grantMinutes: 525600,
      };
    },
  ],
  [
    'incomplete sibling',
    (n: Ticket) => {
      delete n.ticketItemGroup!.ticketItemsV2![0]!.grantMinutes;
    },
  ],
  [
    'missing member list',
    (n: Ticket) => {
      n.ticketItemGroup!.ticketItemsV2 = null;
    },
  ],
] as const) {
  test(`time ticket with ${label} stops before target requests`, async () => {
    const node = source();
    mutate(node);
    const s = setup(node);
    const result = await s.map();
    expect(result.source.code).toBe('insufficient_identity');
    expect(result.targets[0]?.code).toBe('insufficient_identity');
    expect(s.requests).toHaveLength(1);
  });
}

for (const minutes of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid grantMinutes ${minutes} is insufficient identity`, async () => {
    const node = source();
    node.grantMinutes = minutes;
    const s = setup(node);
    expect((await s.map()).targets[0]?.code).toBe('insufficient_identity');
    expect(s.requests).toHaveLength(1);
  });
}

for (const target of [null, { ...group(), ticketItemsV2: [] }]) {
  test(`missing group or empty ordinary-ticket list returns no_candidates (${target === null ? 'null' : '[]'})`, async () => {
    const result = await setup(source(), { US: target }).map();
    expect(result.targets[0]?.code).toBe('no_candidates');
  });
}

for (const [label, mutate] of [
  [
    'missing list',
    (g: Group) => {
      g.ticketItemsV2 = null;
    },
  ],
  [
    'null member',
    (g: Group) => {
      g.ticketItemsV2!.push(null);
    },
  ],
  [
    'missing member duration',
    (g: Group) => {
      delete g.ticketItemsV2![0]!.grantMinutes;
    },
  ],
  [
    'missing member subscription',
    (g: Group) => {
      delete g.ticketItemsV2![0]!.subscriptionTicketItem;
    },
  ],
  [
    'conflicting duplicate SKU',
    (g: Group) => {
      g.ticketItemsV2!.push({ ...g.ticketItemsV2!.at(-1)!, grantMinutes: 43200 });
    },
  ],
] as const) {
  test(`target ${label} cannot establish a unique match`, async () => {
    const target = group();
    mutate(target);
    const result = (await setup(source(), { US: target }).map()).targets[0]!;
    expect(result.code).toBe('insufficient_identity');
    expect(result.nsuid).toBeUndefined();
  });
}

test('subscription and catalog products remain unsupported and are excluded from target candidates', async () => {
  for (const typename of ['NormalSubscriptionTicketItem', 'CatalogTicketItem']) {
    const node = source();
    node.__typename = typename;
    const s = setup(node);
    const result = await s.map();
    expect(result.source.code).toBe('unsupported');
    expect(result.targets[0]?.code).toBe('unsupported');
    expect(s.requests).toHaveLength(1);
  }
  const target = group();
  target.ticketItemsV2!.push({
    __typename: 'NormalSubscriptionTicketItem',
    nsUid: '70080099999999',
    grantMinutes: 525600,
  });
  expect((await setup(source(), { US: target }).map()).targets[0]?.nsuid).toBe('70080000002054');
});

test('time-ticket target permission errors propagate instead of becoming empty candidates', async () => {
  const node = source();
  const client = new NsuidMapper({
    retries: 0,
    fetch: (async (_url, init) => {
      const { query } = JSON.parse(String(init?.body));
      return Response.json(
        query.includes('NsuidMapIdentity')
          ? { data: { item: { itemsV2: [node] } } }
          : {
              errors: [{ message: 'FORBIDDEN', extensions: { errorCode: '5203' } }],
              data: { item: { ticketItemGroup: null } },
            },
      );
    }) as typeof fetch,
  });
  await expect(
    client.mapNsuid(String(node.nsUid), { from: 'HK', to: ['US'] }),
  ).rejects.toBeInstanceOf(NsuidMapError);
});

test('per-call transport options also apply to time-ticket group requests', async () => {
  const seen: RequestInit[] = [];
  const controller = new AbortController();
  const node = source();
  const client = new NsuidMapper({
    fetch: (() => {
      throw new Error('Default fetch must not run');
    }) as unknown as typeof fetch,
  });
  const result = await client.mapNsuid(String(node.nsUid), {
    from: 'HK',
    to: ['US'],
    retries: 0,
    timeoutMs: 1000,
    signal: controller.signal,
    headers: { 'X-Ticket-Test': 'yes' },
    fetch: (async (_url, init) => {
      seen.push(init!);
      expect(new Headers(init?.headers).get('X-Ticket-Test')).toBe('yes');
      expect(init?.signal).toBeTruthy();
      const { query } = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          item: query.includes('NsuidMapIdentity')
            ? { itemsV2: [node] }
            : { ticketItemGroup: group() },
        },
      });
    }) as typeof fetch,
  });
  expect(result.targets[0]?.nsuid).toBe('70080000002054');
  expect(seen).toHaveLength(2);
});
