import { expect, test } from 'bun:test';
import * as api from '../src/index.ts';
import type { AppIdResolver, Identity, RequestOptions } from '../src/index.ts';

test('the root exposes the supported API without internal parsers or defaults', () => {
  expect(Object.keys(api).sort()).toEqual(
    [
      'NsuidMapper',
      'NsuidMapError',
      'MAX_REGIONS_PER_MAP',
      'isAppId',
      'isCatalogId',
      'parseAppId',
      'parseNsuid',
      'itemKindFromNsuid',
      'deriveBaseApplicationIdFromDlcAppId',
      'buildAppIdUrl',
      'contextFor',
      'getCountryLanguageInfo',
      'isCountryLanguageSupported',
      'isMappable',
      'execute',
      'SHOP_ID',
      'fetchIdentities',
      'mapInto',
    ].sort(),
  );
});

// Synthetic title identities and a single-country failure model the gateway's API usage.
const sourceId = '70010000000001';
const targetId = '70010000000002';

function gateway() {
  const state = { sourceReads: 0 };
  const options: RequestOptions = {
    retries: 0,
    fetch: (async (input, init) => {
      if (init?.method === 'GET') {
        if (String(input).endsWith('/GB')) return new Response(null, { status: 503 });
        return new Response(null, {
          status: 307,
          headers: { Location: `/US/en/titles/${targetId}` },
        });
      }
      const { variables } = JSON.parse(String(init?.body));
      if (variables.country === 'JP') state.sourceReads++;
      return Response.json({
        data: {
          item: {
            itemsV2: [
              {
                __typename: 'ApplicationItem',
                nsUid: variables.country === 'JP' ? sourceId : targetId,
                applications: [{ id: '0100000000000000' }],
                labelPlatform: 'HAC',
                romRights: [{ titleId: '0100000000000000' }],
              },
            ],
          },
        },
      });
    }) as typeof fetch,
  };
  return { options, state };
}

test('consumer composition reuses one identity and handles target failures independently', async () => {
  const { options, state } = gateway();
  const { country, language } = api.contextFor('JP');
  const identity: Identity = (
    await api.fetchIdentities([sourceId], country, language, options)
  ).get(sourceId)!;
  const resolver: AppIdResolver = new api.NsuidMapper(options);
  const results = await Promise.allSettled(
    ['US', 'GB']
      .filter(api.isMappable)
      .map((region) => api.mapInto(identity, region, resolver, options)),
  );

  expect(state.sourceReads).toBe(1);
  expect(results[0]).toEqual({
    status: 'fulfilled',
    value: { region: 'US', status: 'mapped', nsuid: targetId },
  });
  expect(results[1]?.status).toBe('rejected');
  if (results[1]?.status === 'rejected') {
    expect(results[1].reason).toBeInstanceOf(api.NsuidMapError);
    expect(results[1].reason.status).toBe(503);
  }
});

test('mapNsuid can return a failed target while keeping the others', async () => {
  const { options } = gateway();
  const mapper = new api.NsuidMapper(options);
  await expect(mapper.mapNsuid(sourceId, { from: 'JP', to: ['US', 'GB'] })).rejects.toBeInstanceOf(
    api.NsuidMapError,
  );
  const result = await mapper.mapNsuid(sourceId, {
    from: 'JP',
    to: ['US', 'GB'],
    targetErrors: 'return',
  });
  expect(result.targets).toEqual([
    { region: 'US', status: 'mapped', nsuid: targetId },
    {
      region: 'GB',
      status: 'error',
      error: { kind: 'http', message: expect.any(String), retryable: true, status: 503 },
    },
  ]);
});
