/** Shared retry policy for the two Nintendo upstreams; each caller owns its timeout. */
export function normalizeRetries(value: number | undefined): number {
  if (value == null) return 2;
  if (!Number.isFinite(value) || value < 0) throw new TypeError('retries must be non-negative');
  return Math.min(Math.trunc(value), 5);
}

export function backoffDelay(attempt: number): number {
  const capped = Math.min(200 * 2 ** attempt, 2_000);
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}

/** Abort interrupts backoff instead of waiting for the next attempt. */
export async function waitForRetry(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
