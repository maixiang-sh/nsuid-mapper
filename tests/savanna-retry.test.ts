import { describe, expect, test } from 'bun:test';

import { NsuidMapError } from '../src/errors.ts';
import { execute } from '../src/upstreams/savanna.ts';

const query = 'query Test { __typename }';

test('a failed transient response body still retains the server retry hint', async () => {
  let calls = 0;
  const delays: number[] = [];
  await execute(
    query,
    {},
    {
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetch: (async () => {
        if (++calls > 1) return Response.json({ data: { ok: true } });
        const response = new Response('{}', { status: 503, headers: { 'Retry-After': '2' } });
        response.text = async () => {
          throw new TypeError('body connection lost');
        };
        return response;
      }) as unknown as typeof fetch,
    },
  );
  expect(calls).toBe(2);
  expect(delays).toEqual([2000]);
});

test('Savanna respects Retry-After seconds and HTTP dates on transient errors', async () => {
  for (const status of [429, 503]) {
    for (const hint of ['2', new Date(Date.now() + 60_000).toUTCString()]) {
      let calls = 0;
      const delays: number[] = [];
      await execute(
        query,
        {},
        {
          timeoutMs: 120_000,
          sleep: async (delay) => {
            delays.push(delay);
          },
          fetch: (async () =>
            ++calls === 1
              ? new Response('{}', { status, headers: { 'Retry-After': hint } })
              : Response.json({ data: { ok: true } })) as unknown as typeof fetch,
        },
      );
      expect(calls).toBe(2);
      expect(delays).toHaveLength(1);
      if (hint === '2') expect(delays[0]).toBe(2000);
      else expect(delays[0]).toBeGreaterThan(50_000);
    }
  }
});

for (const hint of ['60', '9'.repeat(400)]) {
  test(`Savanna Retry-After ${hint.length > 3 ? 'overflow' : 'seconds'} returns the HTTP error when waiting cannot fit`, async () => {
    let calls = 0;
    const error = await execute(
      query,
      {},
      {
        timeoutMs: 10_000,
        sleep: async () => {
          throw new Error('Must not wait beyond the request budget');
        },
        fetch: (async () => {
          calls++;
          return new Response('{}', { status: 429, headers: { 'Retry-After': hint } });
        }) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e);
    expect((error as NsuidMapError).kind).toBe('http');
    expect((error as NsuidMapError).status).toBe(429);
    expect((error as NsuidMapError).retryAfterMs).toBeGreaterThanOrEqual(60_000);
    expect((error as NsuidMapError).retryable).toBeTrue();
    expect(calls).toBe(1);
  });
}

test('caller cancellation ends Savanna server-directed retry waiting', async () => {
  let calls = 0;
  const controller = new AbortController();
  const error = await execute(
    query,
    {},
    {
      signal: controller.signal,
      fetch: (async () => {
        calls++;
        setTimeout(() => controller.abort(), 10);
        return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
      }) as unknown as typeof fetch,
    },
  ).catch((e: unknown) => e);
  expect((error as NsuidMapError).kind).toBe('abort');
  expect(calls).toBe(1);
});

describe('independent Savanna transport resilience', () => {
  test('retries transient connection failures and returns the recovered response', async () => {
    let calls = 0;
    const delays: number[] = [];

    const result = await execute<{ ok: boolean }>(
      query,
      {},
      {
        retries: 2,
        sleep: async (delay) => {
          delays.push(delay);
        },
        fetch: (async () => {
          calls++;
          if (calls < 3) throw new TypeError('Network connection lost.');
          return Response.json({ data: { ok: true } });
        }) as unknown as typeof fetch,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
  });

  test('retries HTTP 429 and 5xx responses', async () => {
    let calls = 0;
    const statuses = [429, 503, 200];

    const result = await execute<{ ok: boolean }>(
      query,
      {},
      {
        retries: 2,
        sleep: async () => {},
        fetch: (async () => {
          const status = statuses[calls++]!;
          return Response.json(status === 200 ? { data: { ok: true } } : { error: 'temporary' }, {
            status,
          });
        }) as unknown as typeof fetch,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  test('does not retry GraphQL or other deliberate upstream answers', async () => {
    let calls = 0;
    const error = await execute(
      query,
      {},
      {
        retries: 2,
        sleep: async () => {},
        fetch: (async () => {
          calls++;
          return Response.json({ errors: [{ message: 'invalid query' }] });
        }) as unknown as typeof fetch,
      },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).kind).toBe('graphql');
    expect((error as NsuidMapError).retryable).toBeFalse();
    expect(calls).toBe(1);
  });

  test('uses one total timeout budget and does not retry after it expires', async () => {
    let calls = 0;
    const error = await execute(
      query,
      {},
      {
        timeoutMs: 5,
        retries: 2,
        sleep: async () => {},
        fetch: (async (_input, init) => {
          calls++;
          await new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
          return Response.json({ data: {} });
        }) as typeof fetch,
      },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).kind).toBe('timeout');
    expect((error as NsuidMapError).message).toContain('timed out after 5ms');
    expect(calls).toBe(1);
  });

  test('caller cancellation interrupts retry backoff', async () => {
    let calls = 0;
    const controller = new AbortController();
    const error = await execute(
      query,
      {},
      {
        signal: controller.signal,
        retries: 2,
        sleep: async () => {
          controller.abort('test cancellation');
        },
        fetch: (async () => {
          calls++;
          throw new TypeError('Network connection lost.');
        }) as unknown as typeof fetch,
      },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).kind).toBe('abort');
    expect(calls).toBe(1);
  });
});

for (const retries of [0, 1]) {
  test(`body-read cancellation is classified on the final attempt (${retries} retries)`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const error = await execute(
      query,
      {},
      {
        retries,
        signal: controller.signal,
        sleep: async () => {},
        fetch: (async () => {
          if (calls++ < retries) throw new TypeError('temporary connection failure');
          controller.abort(new DOMException('caller cancelled', 'AbortError'));
          return new Response(
            new ReadableStream({
              start(stream) {
                stream.error(controller.signal.reason);
              },
            }),
          );
        }) as unknown as typeof fetch,
      },
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).kind).toBe('abort');
    expect((error as NsuidMapError).retryable).toBeFalse();
    expect(calls).toBe(retries + 1);
  });
}

test('timeout while reading the body remains a non-retryable timeout', async () => {
  let calls = 0;
  const error = await execute(
    query,
    {},
    {
      retries: 0,
      timeoutMs: 5,
      fetch: (async (_url, init) => {
        calls++;
        return new Response(
          new ReadableStream({
            start(stream) {
              init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
        );
      }) as typeof fetch,
    },
  ).catch((reason: unknown) => reason);
  expect((error as NsuidMapError).kind).toBe('timeout');
  expect((error as NsuidMapError).retryable).toBeFalse();
  expect(calls).toBe(1);
});

for (const status of [429, 503]) {
  test(`HTTP ${status} with a GraphQL errors envelope still retries`, async () => {
    let calls = 0;
    const result = await execute<{ ok: boolean }>(
      query,
      {},
      {
        retries: 1,
        sleep: async () => {},
        fetch: (async () => {
          calls++;
          return calls === 1
            ? Response.json({ errors: [{ message: 'temporary' }] }, { status })
            : Response.json({ data: { ok: true } });
        }) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
}
for (const body of [
  null,
  [],
  42,
  { data: 42 },
  { data: [] },
  { data: null },
  { errors: 'bad', data: {} },
  { errors: [null], data: {} },
]) {
  test(`malformed GraphQL envelope ${JSON.stringify(body)} is a response error`, async () => {
    let calls = 0;
    const error: unknown = await execute(
      query,
      {},
      {
        retries: 2,
        sleep: async () => {},
        fetch: (async () => {
          calls++;
          return Response.json(body);
        }) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).kind).toBe('response');
    expect((error as NsuidMapError).retryable).toBeFalse();
    expect(calls).toBe(1);
  });
}

for (const stage of ['before-fetch', 'buffered-response', 'successful-body-read'] as const) {
  test(`caller abort at ${stage} prevents a successful Savanna result without retrying`, async () => {
    const controller = new AbortController();
    let calls = 0;
    let released = 0;
    if (stage === 'before-fetch') controller.abort();
    const error = await execute(
      query,
      {},
      {
        signal: controller.signal,
        retries: 2,
        fetch: (async () => {
          calls++;
          if (stage === 'buffered-response') {
            controller.abort();
            return new Response(
              new ReadableStream({
                cancel() {
                  released++;
                },
              }),
            );
          }
          const response = Response.json({ data: { ok: true } });
          const text = response.text.bind(response);
          response.text = async () => {
            const body = await text();
            controller.abort();
            return body;
          };
          return response;
        }) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NsuidMapError);
    expect((error as NsuidMapError).kind).toBe('abort');
    expect((error as NsuidMapError).retryable).toBeFalse();
    expect(calls).toBe(stage === 'before-fetch' ? 0 : 1);
    expect(released).toBe(stage === 'buffered-response' ? 1 : 0);
  });
}

test('a buffered Savanna response returned after the deadline remains a timeout', async () => {
  let calls = 0;
  const error = await execute(
    query,
    {},
    {
      timeoutMs: 5,
      retries: 2,
      fetch: (async (_url, init) => {
        calls++;
        await new Promise<void>((resolve) => {
          init!.signal!.addEventListener('abort', () => resolve(), { once: true });
        });
        return Response.json({ data: { ok: true } });
      }) as typeof fetch,
    },
  ).catch((e: unknown) => e);
  expect((error as NsuidMapError).kind).toBe('timeout');
  expect((error as NsuidMapError).retryable).toBeFalse();
  expect(calls).toBe(1);
});
