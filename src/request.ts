import { NsuidMapError } from './errors.ts';
import { normalizeRetries, retryDelay, waitForRetry } from './retry.ts';
import { normalizeTimeoutMs } from './timeout.ts';
import type { RequestOptions } from './types.ts';

/** One upstream request, including response consumption, retries and backoff. */
export async function requestWithRetry<T>({
  url,
  label,
  init,
  readResponse,
  options = {},
}: {
  url: string;
  label: string;
  init: RequestInit;
  readResponse: (response: Response) => T | Promise<T>;
  options?: RequestOptions & { sleep?: (ms: number) => Promise<void> };
}): Promise<T> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const retries = normalizeRetries(options.retries);
  const deadline = performance.now() + timeoutMs;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  function checkCancellation(cause?: unknown): void {
    const cancelled = options.signal?.aborted;
    if (cancelled || timeout.signal.aborted || performance.now() >= deadline) {
      throw new NsuidMapError(
        cancelled
          ? `${label} request aborted by caller`
          : `${label} request timed out after ${timeoutMs}ms`,
        { url, cause: cause ?? signal.reason, kind: cancelled ? 'abort' : 'timeout' },
      );
    }
  }

  try {
    for (let attempt = 0; ; attempt++) {
      try {
        checkCancellation();
        let response: Response;
        try {
          response = await fetchImpl(url, { ...init, signal });
        } catch (cause) {
          throw new NsuidMapError(
            `${label} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { url, cause, kind: 'network', retryable: true },
          );
        }
        try {
          checkCancellation();
          const result = await readResponse(response);
          // Buffered responses need not reject when the caller cancels during a read.
          checkCancellation();
          return result;
        } finally {
          // Release redirect/error bodies; consumed or locked bodies may reject cancellation.
          void response.body?.cancel().catch(() => {});
        }
      } catch (error) {
        checkCancellation(error);
        if (!(error instanceof NsuidMapError) || !error.retryable || attempt >= retries)
          throw error;

        // A known server wait cannot fit: preserve the HTTP status and hint immediately.
        // retryable still describes the upstream error, so callers may schedule a later retry.
        if (
          error.retryAfterMs !== undefined &&
          error.retryAfterMs >= deadline - performance.now()
        ) {
          throw error;
        }
        try {
          await waitForRetry(retryDelay(attempt, error.retryAfterMs), signal, options.sleep);
        } catch (cause) {
          checkCancellation(cause);
          throw cause;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
