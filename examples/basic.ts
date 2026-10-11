/**
 * Live smoke test for AppID → NSUID resolver.
 *
 *   bun run example
 */
import { NsuidMapper, buildAppIdUrl, contextFor, execute, SHOP_ID } from '../src/index.ts';

const XCX = '0100453019aa8000'; // XenobladeX Definitive Edition

const client = new NsuidMapper({ defaultRegion: 'JP' });

console.log('URL', buildAppIdUrl(XCX, 'JP', { acdIndex: 1 }));

console.log('\n── resolveAppIdToNsuid JP (default acdIndex=0) ──');
const nsuid0 = await client.resolveAppIdToNsuid(XCX, 'JP');
console.log(nsuid0);

console.log('\n── resolveAppId JP acdIndex=0 / 1 ──');
for (const acdIndex of [0, 1]) {
  const r = await client.resolveAppId(XCX, 'JP', { acdIndex });
  console.log({
    acdIndex,
    nsuid: r?.nsuid,
    pathKind: r?.pathKind,
    location: r?.location,
  });
}

console.log('\n── enumerateSkus JP ──');
const skus = await client.enumerateSkus(XCX, 'JP');
for (const s of skus) {
  console.log(s.acdIndex, s.nsuid, s.pathKind, s.location);
}

console.log('\n── multi-region (acdIndex=0) ──');
for (const region of ['JP', 'US', 'HK', 'GB', 'AU', 'DE'] as const) {
  const r = await client.resolveAppId(XCX, region);
  console.log(region.padEnd(3), r?.nsuid ?? '(null)', r?.location?.slice(0, 72) ?? '');
}

console.log('\n── missing app ──');
console.log(await client.resolveAppIdToNsuid('0000000000000000', 'JP'));

console.log('\n── nsuid → nsuid, one call per kind ──');
// Street Fighter 6: title, one of its DLC, and a bundle of DLC. The three take
// different routes internally but the caller does not need to know which.
// One nsuid per call: each country costs up to three requests, all at once.
const mapped = [];
for (const nsuid of ['70010000095202', '70050000056264', '70070000034970', '70030000023159']) {
  mapped.push(await client.mapNsuid(nsuid, { from: 'JP', to: ['US', 'GB', 'HK', 'KR'] }));
}

for (const m of mapped) {
  console.log(`\n${m.source.nsuid}  ${m.source.kind}`);
  for (const t of m.targets) {
    console.log('  ', t.region.padEnd(3), t.nsuid ?? `— ${t.reason}`);
  }
}

console.log('\n── what cannot be mapped, and why ──');
// A demo carries no application id upstream, so there is nothing to anchor on.
// It reports that rather than guessing from the title's name.
const demo = mapped.find((m) => m.source.kind === 'demo');
console.log('demo reason:', demo?.targets[0]?.reason);

console.log('\n── caller-written selection: only the fields you need ──');
// This package returns nsuids, not product data. You write the query, so a
// four-region lookup fetches eight fields instead of fifty.
const MY_QUERY = `
query MyFields($shopId: Int!, $country: CountryCode!, $language: LanguageCode!, $nsUids: [NsUid!]!)
@inContext(country: $country, language: $language, shopId: $shopId) {
  item {
    itemsV2(nsUids: $nsUids) {
      __typename
      ... on ApplicationItem {
        nsUid formalName publisher { name } releaseDateOnEshop
        platform { id name } languages { name isoCode }
      }
      ... on DlcItem    { nsUid formalName publisher { name } releaseDateOnEshop }
      ... on BundleItem { nsUid formalName publisher { name } releaseDateOnEshop }
    }
  }
}`;

const map = await client.mapNsuid('70010000095202', {
  from: 'JP',
  to: ['JP', 'HK', 'US', 'GB'],
});

const rows = await Promise.all(
  map.targets
    .filter((t) => t.nsuid)
    .map(async (t) => {
      const { country, language } = contextFor(t.region);
      const data = await execute<{ item: { itemsV2: Array<Record<string, any>> } }>(MY_QUERY, {
        shopId: SHOP_ID,
        country,
        language,
        nsUids: [Number(t.nsuid)],
      });
      return { region: t.region, item: data.item.itemsV2[0]! };
    }),
);

for (const { region, item } of rows) {
  console.log(
    ' ',
    region.padEnd(3),
    item.nsUid,
    String(item.formalName).slice(0, 24).padEnd(26),
    `${item.publisher?.name} | ${item.releaseDateOnEshop} | ${item.platform?.name ?? '—'} | ${item.languages?.length ?? '—'} langs`,
  );
}
