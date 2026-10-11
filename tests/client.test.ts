import { describe, expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { NsuidMapError } from '../src/errors.ts';
import { execute } from '../src/upstreams/savanna.ts';
import type { AppIdResolveResult } from '../src/types.ts';

/** XenobladeX DE — dual SKU JP (HAC + BEE), 2026-07. */
const XCX_APP = '0100453019aa8000';
const XCX_JP_HAC = '70010000088831';
const XCX_JP_BEE = '70010000116668';

function mockFetch(handlers: Record<string, { status: number; location?: string }>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = handlers[url];
    if (!hit) {
      return new Response(null, { status: 404 });
    }
    const headers = new Headers();
    if (hit.location) headers.set('location', hit.location);
    return new Response(null, { status: hit.status, headers });
  }) as typeof fetch;
}

describe('NsuidMapper (mocked)', () => {
  test('resolveAppIdToNsuid default acdIndex=0', async () => {
    const client = new NsuidMapper({
      fetch: mockFetch({
        [`https://ec.nintendo.com/apps/${XCX_APP}/JP`]: {
          status: 307,
          location: `/JP/ja/titles/${XCX_JP_HAC}`,
        },
      }),
    });
    const nsuid = await client.resolveAppIdToNsuid(XCX_APP, 'JP');
    expect(nsuid).toBe(XCX_JP_HAC);
  });

  test('resolveAppId acdIndex=1 → BEE SKU', async () => {
    const client = new NsuidMapper({
      fetch: mockFetch({
        [`https://ec.nintendo.com/apps/${XCX_APP}/JP?acdIndex=1`]: {
          status: 307,
          location: `/JP/ja/titles/${XCX_JP_BEE}`,
        },
      }),
    });
    const r = await client.resolveAppId(XCX_APP, 'jp', { acdIndex: 1 });
    expect(r).toMatchObject({
      nsuid: XCX_JP_BEE,
      pathKind: 'titles',
      itemKind: 'title',
      region: 'JP',
      acdIndex: 1,
      language: 'ja',
    } satisfies Partial<AppIdResolveResult>);
  });

  test('404 → null', async () => {
    const client = new NsuidMapper({
      fetch: mockFetch({}),
    });
    expect(await client.resolveAppIdToNsuid('0100000000000000', 'JP')).toBeNull();
  });

  test('US pos-redirect Location', async () => {
    const client = new NsuidMapper({
      fetch: mockFetch({
        [`https://ec.nintendo.com/apps/${XCX_APP}/US`]: {
          status: 307,
          location: `https://www.nintendo.com/pos-redirect/70010000088832?l=en&c=US`,
        },
      }),
    });
    const r = await client.resolveAppId(XCX_APP, 'US');
    expect(r?.nsuid).toBe('70010000088832');
    expect(r?.pathKind).toBe('unknown');
  });

  test('EU nsuid query Location', async () => {
    const client = new NsuidMapper({
      fetch: mockFetch({
        [`https://ec.nintendo.com/apps/${XCX_APP}/GB`]: {
          status: 307,
          location:
            'https://www.nintendo-europe.com/redirect/?nsuid=70010000088833&country=GB&language=en',
        },
      }),
    });
    expect(await client.resolveAppIdToNsuid(XCX_APP, 'GB')).toBe('70010000088833');
  });

  test('redirect without product nsuid → null', async () => {
    const client = new NsuidMapper({
      fetch: mockFetch({
        [`https://ec.nintendo.com/apps/${XCX_APP}/KR`]: {
          status: 307,
          location: 'https://www.nintendo.com/kr/games/switch2',
        },
      }),
    });
    expect(await client.resolveAppId(XCX_APP, 'KR')).toBeNull();
  });

  test('redirect without Location throws a typed error', async () => {
    const client = new NsuidMapper({
      fetch: mockFetch({
        [`https://ec.nintendo.com/apps/${XCX_APP}/JP`]: { status: 307 },
      }),
    });
    await expect(client.resolveAppId(XCX_APP, 'JP')).rejects.toThrow('Redirect without Location');
  });

  test('enumerateSkus stops when acdIndex falls back to 0', async () => {
    const client = new NsuidMapper({
      fetch: mockFetch({
        [`https://ec.nintendo.com/apps/${XCX_APP}/JP`]: {
          status: 307,
          location: `/JP/ja/titles/${XCX_JP_HAC}`,
        },
        [`https://ec.nintendo.com/apps/${XCX_APP}/JP?acdIndex=1`]: {
          status: 307,
          location: `/JP/ja/titles/${XCX_JP_BEE}`,
        },
        // acdIndex=2 → server fallback to 0
        [`https://ec.nintendo.com/apps/${XCX_APP}/JP?acdIndex=2`]: {
          status: 307,
          location: `/JP/ja/titles/${XCX_JP_HAC}`,
        },
      }),
    });
    const skus = await client.enumerateSkus(XCX_APP, 'JP');
    expect(skus.map((s) => s.nsuid)).toEqual([XCX_JP_HAC, XCX_JP_BEE]);
    expect(skus.map((s) => s.acdIndex)).toEqual([0, 1]);
  });

  test('defaultRegion', async () => {
    const client = new NsuidMapper({
      defaultRegion: 'JP',
      fetch: mockFetch({
        [`https://ec.nintendo.com/apps/${XCX_APP}/JP`]: {
          status: 307,
          location: `/JP/ja/titles/${XCX_JP_HAC}`,
        },
      }),
    });
    expect(await client.resolveAppIdToNsuid(XCX_APP)).toBe(XCX_JP_HAC);
  });

  test('applies a per-request timeout', async () => {
    const client = new NsuidMapper({
      timeoutMs: 5,
      fetch: (async (_input, init) => {
        await new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        });
        return new Response(null, { status: 500 });
      }) as typeof fetch,
    });

    const error = await client.resolveAppIdToNsuid(XCX_APP, 'JP').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).message).toContain('timed out after 5ms');
    expect((error as NsuidMapError).kind).toBe('timeout');
    expect((error as NsuidMapError).retryable).toBeFalse();
  });

  test('classifies redirector HTTP, network and caller-abort errors', async () => {
    for (const status of [400, 429, 503]) {
      const client = new NsuidMapper({
        fetch: (async () => new Response(null, { status })) as unknown as typeof fetch,
      });
      const error = await client.resolveAppIdToNsuid(XCX_APP, 'JP').catch((e: unknown) => e);
      expect((error as NsuidMapError).kind).toBe('http');
      expect((error as NsuidMapError).retryable).toBe(status !== 400);
    }
    const client = new NsuidMapper({
      fetch: (async () => {
        throw new TypeError('connection reset');
      }) as unknown as typeof fetch,
    });
    const network = await client.resolveAppIdToNsuid(XCX_APP, 'JP').catch((e: unknown) => e);
    expect((network as NsuidMapError).kind).toBe('network');
    expect((network as NsuidMapError).retryable).toBeTrue();
    const aborted = await client
      .resolveAppIdToNsuid(XCX_APP, 'JP', { signal: AbortSignal.abort() })
      .catch((e: unknown) => e);
    expect((aborted as NsuidMapError).kind).toBe('abort');
    expect((aborted as NsuidMapError).retryable).toBeFalse();
  });

  test('rejects unsafe enumerate limits and constructor defaults', async () => {
    const client = new NsuidMapper({ fetch: mockFetch({}) });
    for (const max of [0, 1.5, 33, Number.POSITIVE_INFINITY]) {
      await expect(client.enumerateSkus(XCX_APP, 'JP', { max })).rejects.toBeInstanceOf(TypeError);
    }
    expect(() => new NsuidMapper({ defaultEnumerateMax: 33 })).toThrow(TypeError);
    expect(() => new NsuidMapper({ timeoutMs: 0 })).toThrow(TypeError);
  });

  test('constructor fetch is used by the Savanna identity request', async () => {
    let calls = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { query: string };
      expect(body.query).toContain('NsuidMapAppIds');
      return Response.json({
        data: {
          item: {
            itemsV2: [
              {
                nsUid: 70010000088831,
                applications: [{ id: XCX_APP }],
              },
            ],
          },
        },
      });
    }) as typeof fetch;

    const client = new NsuidMapper({ fetch: fetchImpl });
    expect(await client.resolveNsuidToAppId(XCX_JP_HAC, 'JP')).toBe(XCX_APP);
    expect(calls).toBe(1);
  });

  test('per-call fetch overrides the constructor for both upstreams', async () => {
    let constructorCalls = 0;
    let perCallCalls = 0;
    const constructorFetch = (async () => {
      constructorCalls++;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const perCallFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      perCallCalls++;
      if (String(input).includes('/apps/')) {
        return new Response(null, {
          status: 307,
          headers: { location: `/JP/ja/titles/${XCX_JP_HAC}` },
        });
      }
      const body = JSON.parse(String(init?.body)) as { query: string };
      expect(body.query).toContain('NsuidMapAppIds');
      return Response.json({
        data: {
          item: {
            itemsV2: [{ nsUid: Number(XCX_JP_HAC), applications: [{ id: XCX_APP }] }],
          },
        },
      });
    }) as typeof fetch;

    const client = new NsuidMapper({ fetch: constructorFetch });
    expect(await client.resolveAppIdToNsuid(XCX_APP, 'JP', { fetch: perCallFetch })).toBe(
      XCX_JP_HAC,
    );
    expect(await client.resolveNsuidToAppId(XCX_JP_HAC, 'JP', { fetch: perCallFetch })).toBe(
      XCX_APP,
    );
    expect(constructorCalls).toBe(0);
    expect(perCallCalls).toBe(2);
  });

  test('keeps upstream defaults while applying client and per-call headers', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init?.headers) });
      if (url.includes('/apps/')) {
        return new Response(null, {
          status: 307,
          headers: { location: `/JP/ja/titles/${XCX_JP_HAC}` },
        });
      }
      return Response.json({
        data: {
          item: {
            itemsV2: [{ nsUid: Number(XCX_JP_HAC), applications: [{ id: XCX_APP }] }],
          },
        },
      });
    }) as typeof fetch;
    const client = new NsuidMapper({
      fetch: fetchImpl,
      headers: { 'X-Client': 'client', 'X-Precedence': 'client' },
    });

    await client.resolveAppIdToNsuid(XCX_APP, 'JP', {
      headers: { 'X-Call': 'call', 'X-Precedence': 'call' },
    });
    await client.resolveNsuidToAppId(XCX_JP_HAC, 'JP', {
      headers: { 'X-Call': 'call', 'X-Precedence': 'call' },
    });

    const redirect = seen.find((request) => request.url.includes('/apps/'))!;
    const graphql = seen.find((request) => request.url.includes('savanna'))!;
    expect(redirect.headers.get('accept')).toContain('text/html');
    expect(graphql.headers.get('accept')).toContain('application/graphql-response+json');
    expect(graphql.headers.get('content-type')).toBe('application/json');
    expect(graphql.headers.get('x-nintendo-savanna-client-id')).toBeTruthy();
    for (const request of [redirect, graphql]) {
      expect(request.headers.get('x-client')).toBe('client');
      expect(request.headers.get('x-call')).toBe('call');
      expect(request.headers.get('x-precedence')).toBe('call');
    }
  });
});

test('execute merges direct-call headers with Savanna defaults', async () => {
  let headers: Headers | undefined;
  await execute(
    'query Test { __typename }',
    {},
    {
      headers: { accept: 'application/custom', 'X-Direct': 'yes' },
      fetch: (async (_input, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ data: { ok: true } });
      }) as typeof fetch,
    },
  );

  expect(headers?.get('x-direct')).toBe('yes');
  expect(headers?.get('accept')).toBe('application/custom');
  expect(headers?.get('content-type')).toBe('application/json');
  expect(headers?.get('x-nintendo-savanna-client-id')).toBeTruthy();
});

test('execute normalizes response body read failures', async () => {
  const cause = new Error('stream failed');
  const endpoint = 'https://example.invalid/graphql';
  const error = await execute(
    'query Test { __typename }',
    {},
    {
      endpoint,
      retries: 0,
      fetch: (async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.error(cause);
          },
        });
        return new Response(body, { status: 502 });
      }) as unknown as typeof fetch,
    },
  ).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(NsuidMapError);
  expect((error as NsuidMapError).message).toContain('response body read failed');
  expect((error as NsuidMapError).status).toBe(502);
  expect((error as NsuidMapError).url).toBe(endpoint);
  expect((error as Error).cause).toBe(cause);
});

test('per-call timeout overrides the redirector constructor default', async () => {
  const client = new NsuidMapper({
    timeoutMs: 1000,
    fetch: (async (_url, init) => {
      await new Promise<void>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
      );
      return new Response(null, { status: 500 });
    }) as typeof fetch,
  });
  const error: unknown = await client
    .resolveAppIdToNsuid('01007ef00011e000', 'US', { timeoutMs: 5 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NsuidMapError);
  expect((error as NsuidMapError).kind).toBe('timeout');
  expect((error as NsuidMapError).message).toContain('after 5ms');
});
test('invalid per-call redirector timeout is rejected before fetching', async () => {
  let calls = 0;
  const client = new NsuidMapper({
    fetch: (async () => {
      calls++;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch,
  });
  for (const timeoutMs of [0, -1, Number.NaN, Infinity]) {
    await expect(
      client.resolveAppIdToNsuid('01007ef00011e000', 'US', { timeoutMs }),
    ).rejects.toBeInstanceOf(TypeError);
  }
  expect(calls).toBe(0);
});
