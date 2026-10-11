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

// Longer delays cannot expire within our maximum 120-second request budget.
const MAX_TIMER_MS = 2_147_483_647;

/** RFC 9110: Retry-After is non-negative integer seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value == null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_TIMER_MS);
  // Date.parse also accepts bare numbers; those are not valid HTTP dates.
  if (!/[A-Za-z]/.test(text)) return undefined;
  const date = Date.parse(text);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(0, date - now), MAX_TIMER_MS);
}

/** Never retry earlier than either our backoff or the server's minimum wait. */
export function retryDelay(attempt: number, retryAfterMs?: number): number {
  return Math.max(backoffDelay(attempt), retryAfterMs ?? 0);
}

/** Abort interrupts backoff instead of waiting for the next attempt. */
export async function waitForRetry(
  ms: number,
  signal: AbortSignal,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  let onAbort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const delay = sleep
      ? sleep(ms)
      : new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        });
    await Promise.race([delay, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
