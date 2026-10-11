import { expect, test } from 'bun:test';
import { fetchIdentities, fetchRelatedItems } from '../src/upstreams/savanna.ts';

// Minimal selections verified in the AU public catalog on 2026-10-11.
const tickets = [
  { __typename: 'CatalogTicketItem', nsUid: 70020000000141 },
  { __typename: 'NormalTicketItem', nsUid: 70080000001243 },
];

test('valid ticket types are unsupported, distinct from an omitted catalog product', async () => {
  const missing = '70010099999999'; // Synthetic absent product.
  const result = await fetchIdentities(
    [...tickets.map((n) => String(n.nsUid)), missing],
    'AU',
    'en',
    {
      fetch: (async (_url, init) => {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        // IDs must be selected outside type fragments, including for unknown types.
        expect(query).toContain('__typename nsUid');
        return Response.json({ data: { item: { itemsV2: tickets } } });
      }) as typeof fetch,
    },
  );
  for (const node of tickets) {
    expect(result.get(String(node.nsUid))?.reason).toBe(
      `Unsupported item type: ${node.__typename}`,
    );
  }
  expect(result.get(missing)?.reason).toContain('could not be resolved');
});

test('bundle paging counts DLC entries without fetching their identities, including the last page', async () => {
  const offsets: number[] = [];
  const result = await fetchRelatedItems('70010000029014', 'JP', 'ja', true, {
    fetch: (async (_url, init) => {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { offset: number; firstPage: boolean; withIncludedBundles: boolean };
      };
      expect(query).toContain('upgradeInfo @include(if: $firstPage)');
      expect(query).toContain('upgradeDlcItem @skip(if: $withBundles)');
      expect(query).toContain('... on DlcItem @skip(if: $withBundles)');
      expect(variables.firstPage).toBe(variables.offset === 0);
      expect(variables.withIncludedBundles).toBe(variables.offset === 0);
      offsets.push(variables.offset);
      // Synthetic three-page shape: skipped DLC fields leave only the type tag.
      return Response.json({
        data: {
          item: {
            applicationItem: {
              ...(variables.firstPage
                ? { upgradeInfo: [{ upgradeApplicationItem: { nsUid: 70010000122688 } }] }
                : {}),
              dlcItems: {
                items: Array.from({ length: Math.min(100, 201 - variables.offset) }, () => ({
                  __typename: 'DlcItem',
                })),
                offsetInfo: { total: 201 },
              },
            },
          },
        },
      });
    }) as typeof fetch,
  });
  expect(offsets).toEqual([0, 100, 200]);
  expect(result.scanned).toBe(201);
  expect(result.truncated).toBeFalse();
  expect(result.dlcs).toEqual([]);
  expect(result.upgradeNsuids).toEqual(['70010000122688']);
});

test('a zero-total empty page is a complete scan', async () => {
  const result = await fetchRelatedItems('70010000029014', 'JP', 'ja', false, {
    fetch: (async () =>
      Response.json({
        data: { item: { applicationItem: { dlcItems: { items: [], offsetInfo: { total: 0 } } } } },
      })) as unknown as typeof fetch,
  });
  expect(result.truncated).toBeFalse();
  expect(result.incompleteReason).toBeUndefined();
});
