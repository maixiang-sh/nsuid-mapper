/** Merge HTTP headers case-insensitively; later sources override earlier ones. */
export function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Headers {
  const headers = new Headers();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) headers.set(name, value);
  }
  return headers;
}
