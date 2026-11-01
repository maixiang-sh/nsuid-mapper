import { expect, test } from 'bun:test';
import { NsuidMapper } from '../src/index.ts';

// Synthetic JP/US products: use hex letters so changing case changes the input.
const APP_ID = '0100abcd12340000';
const DLC_ID = '0100abcd12341001';
const TARGET_TITLE = '70010000000002';
type Kind = 'title' | 'dlc' | 'bundle';

function title(nsUid: string, upper: boolean) {
  const id = upper ? APP_ID.toUpperCase() : APP_ID;
  return {
    __typename: 'ApplicationItem',
    nsUid,
    labelPlatform: 'HAC',
    applications: [{ id }],
    romRights: [{ titleId: id }],
    upgradeInfo: [],
  };
}

function product(kind: Kind, nsUid: string, upper: boolean) {
  if (kind === 'title') return title(nsUid, upper);
  const contentId = upper ? DLC_ID.toUpperCase() : DLC_ID;
  const dlc = {
    __typename: 'DlcItem',
    nsUid,
    labelPlatform: 'HAC',
    romRights: [{ titleId: contentId }],
  };
  if (kind === 'dlc') return dlc;
  const memberTitle = title('70010000000011', upper);
  return {
    __typename: 'BundleItem',
    nsUid,
    labelPlatform: 'HAC',
    romRights: [...memberTitle.romRights, ...dlc.romRights],
    itemsV2: [{ item: memberTitle }, { item: { ...dlc, nsUid: '70050000000011' } }],
  };
}

for (const [kind, prefix] of [
  ['title', '7001'],
  ['dlc', '7005'],
  ['bundle', '7007'],
] as const) {
  for (const sourceUpper of [true, false]) {
    const direction = sourceUpper ? 'uppercase JP → lowercase US' : 'lowercase JP → uppercase US';
    test(`${kind}: ROM title IDs match across ${direction}`, async () => {
      const sourceId = `${prefix}0000000001`;
      const targetId = `${prefix}0000000002`;
      const source = product(kind, sourceId, sourceUpper);
      const target = product(kind, targetId, !sourceUpper);
      const client = new NsuidMapper({
        fetch: (async (url, init) => {
          if (init?.method === 'GET') {
            // Application anchors are normalized before using the redirector.
            expect(String(url)).toBe(`https://ec.nintendo.com/apps/${APP_ID}/US`);
            return new Response(null, {
              status: 307,
              headers: { Location: `/US/en/titles/${TARGET_TITLE}` },
            });
          }
          const { query, variables } = JSON.parse(String(init?.body));
          if (query.includes('NsuidMapIdentity')) {
            expect(variables.country).toBe('JP');
            expect(variables.nsUids).toEqual([Number(sourceId)]);
            return Response.json({ data: { item: { itemsV2: [source] } } });
          }
          expect(variables.country).toBe('US');
          if (query.includes('NsuidMapTitleCandidates')) {
            expect(variables.nsUids).toEqual([Number(TARGET_TITLE)]);
            return Response.json({ data: { item: { itemsV2: [target] } } });
          }
          if (query.includes('NsuidMapRelated')) {
            expect(variables.nsUid).toBe(Number(TARGET_TITLE));
            return Response.json({
              data: {
                item: {
                  applicationItem: {
                    upgradeInfo: [],
                    includedBundleItems: kind === 'bundle' ? [target] : [],
                    dlcItems: {
                      items: kind === 'dlc' ? [target] : [],
                      offsetInfo: { total: kind === 'dlc' ? 1 : 0 },
                    },
                  },
                },
              },
            });
          }
          throw new Error('Unexpected query in ROM title ID casing test');
        }) as typeof fetch,
      });

      const result = await client.mapNsuid(sourceId, { from: 'JP', to: ['US'] });
      expect(result.source.titleIds).toEqual(
        kind === 'title' ? [APP_ID] : kind === 'dlc' ? [DLC_ID] : [APP_ID, DLC_ID],
      );
      expect(result.targets).toEqual([{ region: 'US', status: 'mapped', nsuid: targetId }]);
    });
  }
}
