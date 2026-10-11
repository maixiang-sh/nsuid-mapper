import { DEFAULT_TIMEOUT_MS } from './constants.ts';

/** Both upstreams accept the same explicit request budget; invalid values are not rounded or capped. */
export function normalizeTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 120000 ms');
  }
  return timeoutMs;
}
