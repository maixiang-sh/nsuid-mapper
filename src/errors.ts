export class NsuidMapError extends Error {
  readonly status?: number;
  readonly url?: string;
  readonly location?: string;
  readonly retryable: boolean;
  /** Minimum wait requested by a transient HTTP response, in milliseconds. */
  readonly retryAfterMs?: number;
  readonly kind: 'network' | 'timeout' | 'abort' | 'http' | 'graphql' | 'response' | 'other';

  constructor(
    message: string,
    opts?: {
      status?: number;
      url?: string;
      location?: string;
      cause?: unknown;
      retryable?: boolean;
      retryAfterMs?: number;
      kind?: NsuidMapError['kind'];
    },
  ) {
    super(message, { cause: opts?.cause });
    this.name = 'NsuidMapError';
    this.status = opts?.status;
    this.url = opts?.url;
    this.location = opts?.location;
    this.retryable = opts?.retryable ?? false;
    this.retryAfterMs = opts?.retryAfterMs;
    this.kind = opts?.kind ?? 'other';
  }
}
