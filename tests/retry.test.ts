import { expect, test } from 'bun:test';
import { parseRetryAfter, retryDelay, waitForRetry } from '../src/retry.ts';

test('Retry-After accepts integer seconds and HTTP dates, ignoring malformed values', () => {
  const now = Date.parse('Sun, 11 Oct 2026 00:00:00 GMT');
  expect(parseRetryAfter('2', now)).toBe(2000);
  expect(parseRetryAfter(' 0 ', now)).toBe(0);
  expect(parseRetryAfter('Sun, 11 Oct 2026 00:00:03 GMT', now)).toBe(3000);
  expect(parseRetryAfter('Sat, 10 Oct 2026 00:00:00 GMT', now)).toBe(0);
  for (const value of [null, '', '-1', '1.5', 'Infinity', 'tomorrow']) {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  }
  // Huge hints must not overflow setTimeout and cause an immediate retry.
  expect(parseRetryAfter('9'.repeat(400), now)).toBe(2_147_483_647);
});

test('a server wait is a minimum, while zero or missing hints retain jittered backoff', () => {
  expect(retryDelay(0, 2000)).toBe(2000);
  for (const hint of [undefined, 0]) {
    const delay = retryDelay(0, hint);
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThanOrEqual(200);
  }
});

test('caller cancellation interrupts a long default retry wait', async () => {
  const controller = new AbortController();
  const promise = waitForRetry(2_147_483_647, controller.signal);
  controller.abort(new Error('cancelled'));
  await expect(promise).rejects.toThrow('cancelled');
});
