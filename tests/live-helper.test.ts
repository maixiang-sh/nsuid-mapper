import { expect, test } from 'bun:test';
import { NsuidMapError } from '../src/errors.ts';
import { withLiveRetry } from './live-helper.ts';

test('live retry can recover from a transient network failure', async () => {
  let calls = 0;
  await withLiveRetry(async () => {
    calls++;
    if (calls === 1)
      throw new NsuidMapError('connection reset', { kind: 'network', retryable: true });
  });
  expect(calls).toBe(2);
});

test('live retry retries a timeout once and propagates a second failure', async () => {
  let calls = 0;
  const error = new NsuidMapError('timeout', { kind: 'timeout' });
  await expect(
    withLiveRetry(async () => {
      calls++;
      throw error;
    }),
  ).rejects.toBe(error);
  expect(calls).toBe(2);
});

test('live retry does not hide assertions, schema errors or caller cancellation', async () => {
  for (const error of [
    new Error('assertion'),
    new NsuidMapError('schema', { kind: 'graphql' }),
    new NsuidMapError('cancelled', { kind: 'abort' }),
  ]) {
    let calls = 0;
    await expect(
      withLiveRetry(async () => {
        calls++;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});
