/**
 * Paging through a parent title's related items.
 *
 * Upstream caps `limit` at 100. A title with more than that — Monster Hunter
 * Rise ships 265 DLC — would otherwise have everything past the first page
 * reported as "no match", which reads exactly like a correct negative answer.
 *
 * Offline on purpose: this is loop logic, and pinning it to a live title makes
 * the test depend on that title still being big next month.
 */
import { describe, expect, test } from 'bun:test';
import { NsuidMapper } from '../src/index.ts';
import { mapInto } from '../src/mapping.ts';

const TITLE_APPID = '040078001ccf6000';
const WANTED_APPID = '040078001ccf7999'; // sits on the third page

/** A fake upstream: a redirector plus a parent with `total` related items. */
function upstream(total: number, wantedIndex: number) {
  let pages = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);

    // The appId redirector: always resolves the parent title.
    if (href.includes('/apps/')) {
      return new Response(null, {
        status: 307,
        headers: { location: '/US/en/titles/70010000095203' },
      });
    }

    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { nsUids?: number[]; offset?: number; limit?: number };
    };

    if (body.query.includes('NsuidMapIdentity')) {
      return Response.json({
        data: {
          item: {
            itemsV2: [
              {
                __typename: 'DlcItem',
                labelPlatform: 'HAC',
                nsUid: 70050000000001,
                romRights: [{ titleId: WANTED_APPID }],
              },
            ],
          },
        },
      });
    }

    // Related items, one page at a time.
    pages++;
    const offset = body.variables.offset ?? 0;
    const limit = body.variables.limit ?? 100;
    const items = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      items.push({
        __typename: 'DlcItem',
        labelPlatform: 'HAC',
        nsUid: 70050000010000 + i,
        romRights: [{ titleId: i === wantedIndex ? WANTED_APPID : `04007800000${i}` }],
      });
    }
    return Response.json({
      data: {
        item: {
          applicationItem: { dlcItems: { items, offsetInfo: { total } } },
        },
      },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, pages: () => pages };
}

describe('related-item paging', () => {
  test('finds a match that sits past the first page', async () => {
    // The regression: stopping at 100 reported "parent carries no matching
    // item", which is indistinguishable from a genuine miss.
    const { fetchImpl, pages } = upstream(265, 240);
    const r = await new NsuidMapper({ fetch: fetchImpl }).mapNsuid('70050000000001', {
      from: 'JP',
      to: ['US'],
      fetch: fetchImpl,
    });

    expect(r.targets[0]!.nsuid).toBe(String(70050000010000 + 240));
    expect(pages()).toBe(3); // 100 + 100 + 65
  });

  test('stops at one page when the parent has no more', async () => {
    const { fetchImpl, pages } = upstream(25, 10);
    const r = await new NsuidMapper({ fetch: fetchImpl }).mapNsuid('70050000000001', {
      from: 'JP',
      to: ['US'],
      fetch: fetchImpl,
    });

    expect(r.targets[0]!.nsuid).toBe(String(70050000010000 + 10));
    expect(pages()).toBe(1);
  });

  test('reports a genuine miss without claiming truncation', async () => {
    // Nothing carries the wanted appId: the answer is a clean negative, and the
    // reason must not blame paging for it.
    const { fetchImpl } = upstream(25, -1);
    const r = await new NsuidMapper({ fetch: fetchImpl }).mapNsuid('70050000000001', {
      from: 'JP',
      to: ['US'],
      fetch: fetchImpl,
    });

    expect(r.targets[0]!.nsuid).toBeUndefined();
    expect(r.targets[0]!.reason).toContain(
      'No DLC SKU matches the source platform and complete ROM rights',
    );
  });

  test('an empty page ends the walk even when total claims there is more', async () => {
    // Synthetic contradiction: stop rather than repeatedly requesting an
    // empty offset, but report the scan as incomplete rather than a clean miss.
    let pages = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/apps/')) {
        return new Response(null, {
          status: 307,
          headers: { location: '/US/en/titles/70010000095203' },
        });
      }
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes('NsuidMapIdentity')) {
        return Response.json({
          data: {
            item: {
              itemsV2: [
                {
                  __typename: 'DlcItem',
                  labelPlatform: 'HAC',
                  nsUid: 70050000000001,
                  romRights: [{ titleId: '040078001ccf7003' }],
                },
              ],
            },
          },
        });
      }
      pages++;
      // Says 500 remain, returns none. Only the empty-page check stops this.
      return Response.json({
        data: {
          item: { applicationItem: { dlcItems: { items: [], offsetInfo: { total: 500 } } } },
        },
      });
    }) as unknown as typeof fetch;

    const r = await new NsuidMapper({ fetch: fetchImpl }).mapNsuid('70050000000001', {
      from: 'JP',
      to: ['US'],
      fetch: fetchImpl,
    });

    expect(r.targets[0]!.nsuid).toBeUndefined();
    expect(r.targets[0]!.reason).toContain('empty page before declared total');
    expect(pages).toBe(1);
  });
});

// Keep the redirector honest about what it feeds the pager.
describe('appId redirector', () => {
  test('extracts the nsuid from a relative storefront Location', async () => {
    const { fetchImpl } = upstream(1, 0);
    const nsuid = await new NsuidMapper({ fetch: fetchImpl }).resolveAppIdToNsuid(
      TITLE_APPID,
      'US',
    );
    expect(nsuid).toBe('70010000095203');
  });
});

describe('bundle parent candidates', () => {
  const BASE_A = '0100000000000000';
  const BASE_B = '0200000000000000';
  const DLC_A = '0100000000001001';
  const BUNDLE_NSUID = '70070000000001';
  const PARENT_A = '70010000000001';
  const PARENT_B = '70010000000002';

  function bundleNode(fingerprint: string[]) {
    return {
      __typename: 'BundleItem',
      nsUid: Number(BUNDLE_NSUID),
      labelPlatform: 'HAC',
      romRights: fingerprint.map((titleId) => ({ titleId })),
      itemsV2: fingerprint.map((id) => ({
        item:
          (BigInt(`0x${id}`) & 0x1fffn) === 0n
            ? {
                __typename: 'ApplicationItem',
                labelPlatform: 'HAC',
                applications: [{ id }],
                romRights: [{ titleId: id }],
              }
            : { __typename: 'DlcItem', labelPlatform: 'HAC', romRights: [{ titleId: id }] },
      })),
    };
  }
  function bundleIdentity(fingerprint: string[]) {
    const node = bundleNode(fingerprint);
    return {
      nsuid: BUNDLE_NSUID,
      kind: 'bundle' as const,
      labelPlatform: 'HAC',
      titleIds: [...fingerprint].sort(),
      contentAppIds: [...fingerprint].sort(),
      contentKeys: node.itemsV2
        .map(({ item }) =>
          JSON.stringify([
            item.__typename,
            item.labelPlatform,
            item.applications?.map((a) => a.id) ?? [],
            item.romRights.map((r) => r.titleId),
          ]),
        )
        .sort(),
    };
  }

  function bundleFetch(
    fingerprint: string[],
    matchingParent: string,
    relation: 'dlc' | 'included' = 'dlc',
  ) {
    return (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { nsUid?: number };
      };
      if (body.query.includes('NsuidMapRelated')) {
        const matches = String(body.variables.nsUid) === matchingParent;
        return Response.json({
          data: {
            item: {
              applicationItem: {
                includedBundleItems:
                  matches && relation === 'included' ? [{ nsUid: Number(BUNDLE_NSUID) }] : [],
                dlcItems: {
                  items:
                    matches && relation === 'dlc'
                      ? [{ __typename: 'BundleItem', nsUid: Number(BUNDLE_NSUID) }]
                      : [],
                  offsetInfo: { total: matches && relation === 'dlc' ? 1 : 0 },
                },
              },
            },
          },
        });
      }
      if (body.query.includes('NsuidMapBundleContents')) {
        return Response.json({
          data: {
            item: {
              itemsV2: [bundleNode(fingerprint)],
            },
          },
        });
      }
      throw new Error('unexpected query');
    }) as typeof fetch;
  }

  test('a base game plus its DLC deduplicates to the base parent', async () => {
    const resolved: string[] = [];
    const fingerprint = [BASE_A, DLC_A];
    const result = await mapInto(
      bundleIdentity(fingerprint),
      'US',
      {
        resolve: async (appId) => {
          resolved.push(appId);
          return PARENT_A;
        },
      },
      { fetch: bundleFetch(fingerprint, PARENT_A) },
    );

    expect(result.nsuid).toBe(BUNDLE_NSUID);
    expect(resolved).toEqual([BASE_A]);
  });

  test('finds a full-game bundle through the parent included-bundle relation', async () => {
    const fingerprint = [BASE_A, DLC_A];
    const result = await mapInto(
      bundleIdentity(fingerprint),
      'US',
      { resolve: async () => PARENT_A },
      { fetch: bundleFetch(fingerprint, PARENT_A, 'included') },
    );

    expect(result.nsuid).toBe(BUNDLE_NSUID);
  });

  test('tries the next distinct base parent when the first does not contain the bundle', async () => {
    const resolved: string[] = [];
    const fingerprint = [BASE_A, BASE_B];
    const result = await mapInto(
      bundleIdentity(fingerprint),
      'US',
      {
        resolve: async (appId) => {
          resolved.push(appId);
          return appId === BASE_A ? PARENT_A : PARENT_B;
        },
      },
      { fetch: bundleFetch(fingerprint, PARENT_B) },
    );

    expect(result.nsuid).toBe(BUNDLE_NSUID);
    expect(resolved).toEqual([BASE_A, BASE_B]);
  });

  test('reports valid but non-parent application ids accurately', async () => {
    let resolverCalls = 0;
    const result = await mapInto(
      {
        nsuid: BUNDLE_NSUID,
        kind: 'bundle',
        labelPlatform: 'HAC',
        titleIds: [BASE_A],
        contentKeys: ['invalid anchors'],
        contentAppIds: ['0100000000000800', 'not-an-app-id'],
      },
      'US',
      {
        resolve: async () => {
          resolverCalls++;
          return PARENT_A;
        },
      },
    );

    expect(result.nsuid).toBeUndefined();
    expect(result.reason).toContain('no valid parent application id');
    expect(result.reason).toContain('1 malformed application id');
    expect(result.reason).toContain('1 application id outside the base/DLC ranges');
    expect(result.reason).not.toContain('not 16-hex');
    expect(resolverCalls).toBe(0);
  });
});
