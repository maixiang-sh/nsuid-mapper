import { expect, test } from 'bun:test';
import { NsuidMapError } from '../src/errors.ts';
import { requestWithRetry } from '../src/request.ts';

test('server wait is compared with the remaining budget, preserving the original error', async () => {
  let calls = 0;
  let waits = 0;
  const error = new NsuidMapError('upstream unavailable', {
    status: 503,
    kind: 'http',
    retryable: true,
    retryAfterMs: 1000,
  });
  const result = await requestWithRetry({
    url: 'https://example.invalid',
    label: 'test',
    init: {},
    options: {
      timeoutMs: 1200,
      fetch: (async () => {
        calls++;
        await Bun.sleep(300);
        return new Response('{}', { status: 503 });
      }) as unknown as typeof fetch,
      sleep: async () => {
        waits++;
      },
    },
    readResponse: () => {
      throw error;
    },
  }).catch((e: unknown) => e);
  expect(result).toBe(error);
  expect(calls).toBe(1);
  expect(waits).toBe(0);
});

test('caller abort takes priority over an HTTP error with an excessive retry hint', async () => {
  const controller = new AbortController();
  const result = await requestWithRetry({
    url: 'https://example.invalid',
    label: 'test',
    init: {},
    options: {
      signal: controller.signal,
      fetch: (async () => new Response('{}')) as unknown as typeof fetch,
    },
    readResponse: () => {
      controller.abort();
      throw new NsuidMapError('upstream unavailable', {
        status: 503,
        kind: 'http',
        retryable: true,
        retryAfterMs: 60_000,
      });
    },
  }).catch((e: unknown) => e);
  expect((result as NsuidMapError).kind).toBe('abort');
  expect((result as NsuidMapError).retryable).toBeFalse();
});

test('an unexpected response parser error is not retried as a network failure', async () => {
  let calls = 0;
  const bug = new TypeError('parser bug');
  const result = await requestWithRetry({
    url: 'https://example.invalid',
    label: 'test',
    init: {},
    options: {
      fetch: (async () => {
        calls++;
        return new Response('{}');
      }) as unknown as typeof fetch,
    },
    readResponse: () => {
      throw bug;
    },
  }).catch((e: unknown) => e);
  expect(result).toBe(bug);
  expect(calls).toBe(1);
});
