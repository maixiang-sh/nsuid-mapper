import { expect, test } from 'bun:test';
import { NsuidMapper } from '../src/client.ts';
import { normalizeTimeoutMs } from '../src/timeout.ts';
import { execute } from '../src/upstreams/savanna.ts';

const query = 'query Test { __typename }';

test('request timeout defaults and integer boundaries are explicit', () => {
  expect(normalizeTimeoutMs(undefined)).toBe(10_000);
  expect(normalizeTimeoutMs(1)).toBe(1);
  expect(normalizeTimeoutMs(120_000)).toBe(120_000);
});

test('both transports reject the same invalid timeout before any fetch', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    throw new Error('Invalid budgets must not reach the transport');
  }) as unknown as typeof fetch;
  const client = new NsuidMapper({ fetch: fetchImpl });
  for (const timeoutMs of [0, -1, 0.5, 12.75, 120_001, NaN, Infinity]) {
    expect(() => new NsuidMapper({ timeoutMs })).toThrow(TypeError);
    await expect(execute(query, {}, { timeoutMs, fetch: fetchImpl })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      client.resolveAppId('0100559011740000', 'JP', { timeoutMs }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.resolveNsuidToAppId('70010000029014', 'JP', { timeoutMs }),
    ).rejects.toBeInstanceOf(TypeError);
  }
  expect(calls).toBe(0);
});

test('both transports accept the upper timeout boundary unchanged', async () => {
  const fetchImpl = (async (_url, init) =>
    init?.method === 'POST'
      ? Response.json({ data: { item: { itemsV2: [] } } })
      : new Response(null, { status: 404 })) as typeof fetch;
  const client = new NsuidMapper({ timeoutMs: 120_000, fetch: fetchImpl });
  expect(await client.resolveAppId('0100559011740000', 'JP')).toBeNull();
  expect(await client.resolveNsuidToAppId('70010000029014', 'JP')).toBeNull();
});
