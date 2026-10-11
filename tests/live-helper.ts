import { test } from 'bun:test';
import { NsuidMapError } from '../src/errors.ts';

/** Retry a live read once; assertion, schema and caller-abort errors still fail immediately. */
export async function withLiveRetry(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof NsuidMapError) || !(error.kind === 'timeout' || error.retryable)) {
      throw error;
    }
    console.warn(`[live retry 1/1] ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await run();
  }
}

export function live(name: string, run: () => Promise<void>, timeoutMs: number): void {
  if (process.env.LIVE || process.env.EC_LIVE) {
    test(name, () => withLiveRetry(run), timeoutMs);
  } else {
    test.skip(name, run, timeoutMs);
  }
}
