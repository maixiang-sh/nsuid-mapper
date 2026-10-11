import { expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { NsuidMapError } from '../src/errors.ts';

// Real US/AU Xenoblade 2 IDs; only failures injected below are synthetic.
const APP = '0100e95004038000';
const SOURCE = 70010000000707;
const TARGET = 70010000000706;
const redirect = () =>
  new Response(null, { status: 307, headers: { location: `/AU/en/titles/${TARGET}` } });

for (const status of [429, 503]) {
  test(`redirector honors Retry-After before retrying HTTP ${status}`, async () => {
    let calls = 0;
    let receivedAt = 0;
    let retriedAt = 0;
    const mapper = new NsuidMapper({
      fetch: (async () => {
        if (++calls === 1) {
          receivedAt = Date.now();
          return new Response(null, { status, headers: { 'Retry-After': '1' } });
        }
        retriedAt = Date.now();
        return redirect();
      }) as unknown as typeof fetch,
    });
    expect(await mapper.resolveAppIdToNsuid(APP, 'AU')).toBe(String(TARGET));
    expect(calls).toBe(2);
    expect(retriedAt - receivedAt).toBeGreaterThanOrEqual(1000);
  });
}

test('redirector Retry-After HTTP date is bounded by the request timeout', async () => {
  let calls = 0;
  const mapper = new NsuidMapper({
    timeoutMs: 10,
    fetch: (async () => {
      calls++;
      return new Response(null, {
        status: 503,
        headers: {
          'Retry-After': new Date(Date.now() + 60_000).toUTCString(),
        },
      });
    }) as unknown as typeof fetch,
  });
  const error = await mapper.resolveAppId(APP, 'AU').catch((e: unknown) => e);
  expect((error as NsuidMapError).kind).toBe('timeout');
  expect(calls).toBe(1);
});

test('caller cancellation ends redirector server-directed retry waiting', async () => {
  let calls = 0;
  const controller = new AbortController();
  const mapper = new NsuidMapper({
    fetch: (async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return new Response(null, { status: 429, headers: { 'Retry-After': '3600' } });
    }) as unknown as typeof fetch,
  });
  const error = await mapper
    .resolveAppId(APP, 'AU', { signal: controller.signal })
    .catch((e: unknown) => e);
  expect((error as NsuidMapError).kind).toBe('abort');
  expect(calls).toBe(1);
});

for (const failure of ['network', 429, 503] as const) {
  test(`redirector recovers from a transient ${failure}`, async () => {
    let calls = 0;
    let released = 0;
    const client = new NsuidMapper({
      fetch: (async () => {
        if (++calls === 1) {
          if (failure === 'network') throw new TypeError('connection reset');
          return new Response(
            new ReadableStream({
              cancel() {
                released++;
              },
            }),
            { status: failure },
          );
        }
        return redirect();
      }) as unknown as typeof fetch,
    });
    expect(await client.resolveAppIdToNsuid(APP, 'AU')).toBe(String(TARGET));
    expect(calls).toBe(2);
    expect(released).toBe(failure === 'network' ? 0 : 1);
  });
}

test('redirector default permits two extra attempts', async () => {
  let calls = 0;
  const client = new NsuidMapper({
    fetch: (async () =>
      ++calls <= 2 ? new Response(null, { status: 503 }) : redirect()) as unknown as typeof fetch,
  });
  expect(await client.resolveAppIdToNsuid(APP, 'AU')).toBe(String(TARGET));
  expect(calls).toBe(3);
});

test('redirector per-call retry count overrides the constructor and reports exhaustion', async () => {
  let calls = 0;
  const client = new NsuidMapper({
    retries: 2,
    fetch: (async () => {
      calls++;
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch,
  });
  for (const retries of [0, 1]) {
    calls = 0;
    const error = await client.resolveAppId(APP, 'AU', { retries }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).kind).toBe('http');
    expect((error as NsuidMapError).retryable).toBeTrue();
    expect(calls).toBe(retries + 1);
  }
});

for (const status of [200, 400, 404, 307]) {
  test(`redirector does not retry a deliberate ${status} response`, async () => {
    let calls = 0;
    const client = new NsuidMapper({
      fetch: (async () => {
        calls++;
        // The 307 deliberately lacks Location and must fail without retrying.
        return new Response(null, { status });
      }) as unknown as typeof fetch,
    });
    const result = await client.resolveAppId(APP, 'AU').catch((e: unknown) => e);
    expect(calls).toBe(1);
    if (status === 200 || status === 404) expect(result).toBeNull();
    else {
      expect(result).toBeInstanceOf(NsuidMapError);
      expect((result as NsuidMapError).retryable).toBeFalse();
    }
  });
}

test('redirector retries and backoff share one total timeout', async () => {
  let calls = 0;
  const client = new NsuidMapper({
    timeoutMs: 10,
    fetch: (async () => {
      calls++;
      return new Response(null, { status: 503 });
    }) as unknown as typeof fetch,
  });
  const error = await client.resolveAppId(APP, 'AU').catch((e: unknown) => e);
  expect((error as NsuidMapError).kind).toBe('timeout');
  expect((error as NsuidMapError).retryable).toBeFalse();
  expect(calls).toBe(1);
});

test('caller cancellation interrupts redirector backoff', async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = new NsuidMapper({
    fetch: (async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return new Response(null, { status: 429 });
    }) as unknown as typeof fetch,
  });
  const error = await client
    .resolveAppId(APP, 'AU', { signal: controller.signal })
    .catch((e: unknown) => e);
  expect((error as NsuidMapError).kind).toBe('abort');
  expect((error as NsuidMapError).retryable).toBeFalse();
  expect(calls).toBe(1);
});

test('an already cancelled redirector request performs no fetch', async () => {
  let calls = 0;
  const client = new NsuidMapper({
    fetch: (async () => {
      calls++;
      return redirect();
    }) as unknown as typeof fetch,
  });
  const error = await client
    .resolveAppId(APP, 'AU', { signal: AbortSignal.abort() })
    .catch((e: unknown) => e);
  expect((error as NsuidMapError).kind).toBe('abort');
  expect(calls).toBe(0);
});

test('invalid redirector retry counts fail before fetching', async () => {
  let calls = 0;
  const client = new NsuidMapper({
    fetch: (async () => {
      calls++;
      return redirect();
    }) as unknown as typeof fetch,
  });
  for (const retries of [-1, NaN, Infinity]) {
    expect(() => new NsuidMapper({ retries })).toThrow(TypeError);
    await expect(client.resolveAppId(APP, 'AU', { retries })).rejects.toBeInstanceOf(TypeError);
  }
  expect(calls).toBe(0);
});

test('one transient country failure recovers within the existing complete-result contract', async () => {
  const getCalls = new Map<string, number>();
  const client = new NsuidMapper({
    fetch: (async (url, init) => {
      if (init?.method !== 'POST') {
        const country = String(url).endsWith('/AU') ? 'AU' : 'US';
        const attempts = (getCalls.get(country) ?? 0) + 1;
        getCalls.set(country, attempts);
        if (country === 'AU' && attempts === 1) return new Response(null, { status: 503 });
        return new Response(null, {
          status: 307,
          headers: { location: `/${country}/en/titles/${country === 'AU' ? TARGET : SOURCE}` },
        });
      }
      const body = JSON.parse(String(init.body)) as { variables: { country: string } };
      return Response.json({
        data: {
          item: {
            itemsV2: [
              {
                __typename: 'ApplicationItem',
                nsUid: body.variables.country === 'AU' ? TARGET : SOURCE,
                applications: [{ id: APP }],
                labelPlatform: 'HAC',
                romRights: [{ titleId: APP }],
                upgradeInfo: [],
              },
            ],
          },
        },
      });
    }) as typeof fetch,
  });
  const r = await client.mapNsuid(SOURCE, { from: 'US', to: ['AU', 'US'] });
  expect(r.targets.map((t) => t.nsuid)).toEqual([String(TARGET), String(SOURCE)]);
  expect(getCalls.get('AU')).toBe(2);
  expect(getCalls.get('US')).toBe(1);
});

for (const status of [200, 307, 404]) {
  test(`buffered redirector ${status} after caller abort is rejected and released`, async () => {
    const controller = new AbortController();
    let calls = 0;
    let released = 0;
    const client = new NsuidMapper({
      fetch: (async () => {
        calls++;
        controller.abort();
        return new Response(
          new ReadableStream({
            cancel() {
              released++;
            },
          }),
          {
            status,
            headers: { location: `/AU/en/titles/${TARGET}` },
          },
        );
      }) as unknown as typeof fetch,
    });
    const error = await client
      .resolveAppId(APP, 'AU', { signal: controller.signal })
      .catch((e: unknown) => e);
    expect((error as NsuidMapError).kind).toBe('abort');
    expect((error as NsuidMapError).retryable).toBeFalse();
    expect(calls).toBe(1);
    expect(released).toBe(1);
  });
}

test('redirector headers returned after the deadline remain a timeout', async () => {
  let calls = 0;
  const client = new NsuidMapper({
    timeoutMs: 5,
    fetch: (async (_url, init) => {
      calls++;
      await new Promise<void>((resolve) => {
        init!.signal!.addEventListener('abort', () => resolve(), { once: true });
      });
      return redirect();
    }) as typeof fetch,
  });
  const error = await client.resolveAppId(APP, 'AU').catch((e: unknown) => e);
  expect((error as NsuidMapError).kind).toBe('timeout');
  expect((error as NsuidMapError).retryable).toBeFalse();
  expect(calls).toBe(1);
});
