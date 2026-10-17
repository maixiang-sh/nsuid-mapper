import { expect, test } from 'bun:test';
import { mapInto, type AppIdResolver, type Identity } from '../src/index.ts';

// A source problem blocks every target without any target request.
const resolver: AppIdResolver = {
  resolve: () => {
    throw new Error('no target request expected');
  },
};

test('a source missing from its catalog carries source_not_found to each target', async () => {
  const source: Identity = {
    nsuid: '70010000000001',
    kind: 'unknown',
    code: 'source_not_found',
    reason: "The source NSUID was not returned by this region's catalog",
  };
  expect(await mapInto(source, 'us', resolver)).toEqual({
    region: 'US',
    code: 'source_not_found',
    reason: source.reason,
  });
});

test('every unmapped target has a code, including kinds without an anchor', async () => {
  const consumable: Identity = {
    nsuid: '70090000000001',
    kind: 'consumable',
    code: 'unsupported',
    reason: 'upstream exposes no application id for consumables',
  };
  expect((await mapInto(consumable, 'GB', resolver)).code).toBe('unsupported');
  // An identity without its own code still gets the branch's category.
  const title: Identity = { nsuid: '70010000000001', kind: 'title' };
  expect((await mapInto(title, 'JP', resolver)).code).toBe('insufficient_identity');
  const other: Identity = { nsuid: '70010000000001', kind: 'unknown' };
  expect((await mapInto(other, 'JP', resolver)).code).toBe('unsupported');
});
