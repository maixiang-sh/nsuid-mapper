# @nintendo-store/nsuid-mapper

[中文说明](README.zh-CN.md)

Map a Nintendo eShop **nsuid** to the same product's nsuid in other regions.

An nsuid is region-local: Street Fighter 6 is `70010000095202` in Japan and
`70010000095203` in the US, and querying one in the other's context returns
nothing rather than the equivalent. There is no upstream "same product, other
region" API. This package builds that hop out of two public pieces.

```ts
import { NsuidMapper } from '@nintendo-store/nsuid-mapper';

const mapper = new NsuidMapper();
const r = await mapper.mapNsuid('70010000095202', {
  from: 'JP',
  to: ['HK', 'US', 'GB'],
});

r.targets;
// [ { region: 'HK', nsuid: '70010000095206' },
//   { region: 'US', nsuid: '70010000095203' },
//   { region: 'GB', nsuid: '70010000095204' } ]
```

## What maps, and what does not

Titles, DLC and bundles map when upstream provides a complete, unique SKU
identity. Nothing is matched by name.

| kind          | anchor                                      | how the target is found                     |
| ------------- | ------------------------------------------- | ------------------------------------------- |
| `7001` title  | appId, platform and full title-right set    | redirector plus verified upgrade candidates |
| `7005` dlc    | platform and full right set                 | parent's DLC/upgrade list, unique SKU match |
| `7007` bundle | platform, full rights and member signatures | all linked parents, unique identity match   |

Bundles carry no appId of their own. A single member's first appId or right is
insufficient: base and Switch 2 editions can share appIds, and passes can differ
only in additional rights or subscription durations.

### DLC identity

DLC matching uses `labelPlatform` and every `romRights.titleId`, normalized and
sorted. All rights contribute to parent discovery; the first right alone is
not used to choose a target. Candidates from `dlcItems` and
`upgradeInfo.upgradeDlcItem` are deduplicated by nsuid, and exactly one complete
match is required. Different platforms, additional rights, ambiguous matches,
or an incomplete candidate scan return a reason rather than a partial match.

`resolveNsuidsToAppIds` still returns one representative ID per title/DLC for
compatibility. It is an ID lookup, not a complete cross-region SKU comparison.

### Bundle identity and limits

Bundle matching compares:

- The bundle's `labelPlatform` and **all** `romRights.titleId` values.
- Each application / DLC member's type, platform, all application IDs and all ROM rights.
- Each consumable member's `itemId` and `consumableItemGroup.publisher.id`.
- Repeated members as separate entries; member ordering and hexadecimal ID casing do not matter.

Consumable `itemId` values are opaque strings, compared exactly without trimming,
case folding or parsing their words. Publisher ID scopes each consumable identity;
the complete bundle's applications, platform and rights constrain the match too.
`consumableItemGroup.id` is not compared: NBA 2K26 uses different group IDs across
regions while the member `itemId` and publisher ID stay the same.

Member selections include `PUBLIC` and `UNSEARCHABLE`. A non-searchable member
can contain the rights that distinguish three-month and twelve-month passes.
Candidate discovery follows the parent's base/upgrade links and examines all
reachable candidates before accepting exactly one match.

`source.contentAppIds` contains every member application and right ID, used to
find parent applications. `source.contentKeys` contains the canonical member
signatures used for comparison. These are derived metadata, not upstream fields.

Unsupported member types, missing application / DLC rights, missing consumable
`itemId` or publisher ID, multiple
exact matches, or incomplete scans return a `reason` without an nsuid. This
intentionally leaves some bundles unmapped rather than selecting another
edition. Parent listings do not cover every unavailable product: the verified
`NOT_SALE` Monster Hunter Rise Deluxe bundle is absent, and that status is not
accepted by the listing filter. The package does not search names or add a
storefront scraping fallback.

Per target country, scans are bounded to 16 parent titles, 40 DLC pages per
parent, and 50 detailed bundle identities per request. Reaching a parent or
paging cap prevents accepting a result from the incomplete scan.
An empty page before the declared total also reports an incomplete scan; a
zero-total empty list remains a complete result.

Related-item queries select only what the current mapping needs: bundle paging
collects candidate NSUIDs, then reads their complete identities in batches. It
does not fetch unrelated DLC rights. Upgrade links and included bundles are
selected only on the first page of each parent.

**Standalone `7003` demos and `7009` consumables do not map.** They expose no
application ID for parent discovery. A consumable's `itemId` can identify it within
a bundle, whose other members supply parent anchors, but does not provide a lookup
of the standalone consumable in other countries. Each target returns a reason:

```ts
const demo = await mapper.mapNsuid('70030000023159', { from: 'JP', to: ['US'] });
demo.targets[0];
// { region: 'US', reason: 'upstream exposes no application id for demos' }
```

`7002` catalog tickets and `7008` normal tickets are recognized as existing
products but are not mapped. Their `source.kind` is `unknown` and `reason` names
the unsupported upstream type, such as `Unsupported item type: CatalogTicketItem`.
This differs from a product omitted by `itemsV2`, which returns a region lookup
failure. Subscription tickets not exposed by `itemsV2` cannot be identified here.

Two regions also answer with a reason rather than an nsuid: **KR** redirects to
a generic storefront and **TW** returns a page with no redirect at all.

## Fetching details for the mapped products

This package deliberately does not fetch product data. It returns nsuids and
gives you the pieces to query exactly the fields you want — asking for fifty
when you need eight is the common waste here.

```ts
import { NsuidMapper, execute, contextFor, SHOP_ID } from '@nintendo-store/nsuid-mapper';

// Your selection, your fields.
const MY_QUERY = `
query MyFields($shopId: Int!, $country: CountryCode!, $language: LanguageCode!, $nsUids: [NsUid!]!)
@inContext(country: $country, language: $language, shopId: $shopId) {
  item {
    itemsV2(nsUids: $nsUids) {
      __typename
      ... on ApplicationItem {
        nsUid formalName publisher { name } releaseDateOnEshop
        platform { id name } languages { name isoCode } applications { id }
      }
      ... on DlcItem    { nsUid formalName publisher { name } releaseDateOnEshop romRights { titleId } }
      ... on BundleItem { nsUid formalName publisher { name } releaseDateOnEshop }
    }
  }
}`;

const map = await mapper.mapNsuid(nsuid, { from: 'JP', to: ['JP', 'HK', 'US', 'GB'] });

const rows = await Promise.all(
  map.targets
    .filter((t) => t.nsuid)
    .map(async (t) => {
      const { country, language } = contextFor(t.region);
      const data = await execute(MY_QUERY, {
        shopId: SHOP_ID,
        country,
        language,
        nsUids: [Number(t.nsuid)],
      });
      return { region: t.region, ...data.item.itemsV2[0] };
    }),
);
```

Two things that will bite when writing a selection:

- **Field names come from the schema, not from a client's output.** For example,
  select `platform { id name }`, not a derived `platformName`. The minimal
  mapping selections are in `src/upstreams/savanna.ts`.
- **An invalid field returns `400 INVALID_PARAM` naming nothing.** Add fields one
  at a time when something breaks.

Selections depend on the object type. For edition matching, use `labelPlatform`;
`platform.id` alone does not reliably distinguish base games from Switch 2
editions. Do not assume every field on a title exists on DLC or bundles.

## Cost

| kind   | requests                                                                          |
| ------ | --------------------------------------------------------------------------------- |
| title  | 1 identity + 2–3 per region (redirect, candidate identity, linked editions)       |
| dlc    | 1 identity + 2 per region                                                         |
| bundle | 1 identity + parent redirects + related lists and candidate identities per region |

Countries resolve concurrently, so the wall-clock cost of a map is roughly one
country's latency rather than the sum.

**One nsuid per `mapNsuid` call, and at most eight countries.** Countries fire
together; batching nsuids as well would multiply the two counts into a burst
against Nintendo's edge. A normal bundle has one deduplicated parent candidate
and normally costs three requests per country when its related list and bundle
identities each fit in one request. Linked editions and multi-game collections
require more parent scans, performed sequentially within each country. All
reachable parents are scanned to detect ambiguous matches; DLC pagination and
large candidate batches add requests. The country cap is `MAX_REGIONS_PER_MAP`,
and exceeding it throws rather than silently truncating.

Eight is enough for one country per publishing region — JPN, USA, EUR, AUS,
TWN, plus room for KOR, CHN and SEA, which the redirector does not serve yet.

The id lookup has no such limit: `resolveNsuidsToAppIds` stays one request
however many nsuids you pass, so batch freely there.

### Country languages

Savanna requires a `language` variable, but unavailable values can still return
data. `MAPPABLE_COUNTRY_LANGUAGES` records official configured codes for the 45
verified mapping countries; it does not guarantee a translated product variant.
Savanna itself accepts more country configurations than the redirector maps.

```ts
import { getCountryLanguageInfo, isCountryLanguageSupported } from '@nintendo-store/nsuid-mapper';

getCountryLanguageInfo('CH');
// { defaultLanguage: 'de', languages: ['fr', 'de', 'it'] }

isCountryLanguageSupported('US', 'es'); // true
isCountryLanguageSupported('JP', 'en'); // false — not listed in JP country configuration
```

`contextFor(country)` uses the recorded default automatically. Identity fields
such as nsuid and appId do not change with language; localized presentation
fields such as language names can, but individual product text may remain unchanged.

## How it works

Two upstreams, neither of which is a cross-region API on its own:

1. **Savanna GraphQL** — `nsuid → 16-hex application id`. The query lives in
   `src/upstreams/savanna.ts` and includes SKU and upgrade identity.
2. **`ec.nintendo.com/apps/{appId}/{REGION}`** — a redirector whose `Location`
   carries that region's nsuid. Its request, timeout, SKU and `Location` parsing
   live in `src/upstreams/redirector.ts`. Three response shapes are documented
   in [`docs/apps-redirector.md`](docs/apps-redirector.md).

`src/client.ts` is only the public facade, while `src/mapping.ts` contains the
cross-region matching decisions. The two upstream protocols therefore can
change independently without splitting this project into separate packages.

### Network resilience

Savanna and the AppID Redirector share a small retry policy: transient network
failures, HTTP 429 and HTTP 5xx get up to two extra attempts with exponential
backoff and jitter. `retries` configures both upstreams, at construction or per
call; `0` disables retries and the maximum is `5`. Every attempt and backoff
shares one request's timeout budget, which defaults to 10 seconds. Caller
cancellation interrupts backoff and an already cancelled redirector call makes
no request.

A transient Savanna HTTP status takes precedence even when the body contains
GraphQL `errors`. Other GraphQL errors, other 4xx responses, malformed successful
responses, timeouts, and caller cancellation are not retried. Redirector 200 /
404 results and redirects without a usable product are not retried either;
a redirect missing its Location is a non-retryable error. Redirector response
bodies are released because only headers are needed.

Successful responses require an object envelope and an object `data`; malformed
envelopes return a `NsuidMapError` with `kind: 'response'`. This validates the
GraphQL envelope, not every nested product field.

Defaults can be adjusted globally or per call:

```ts
const mapper = new NsuidMapper({ timeoutMs: 15_000, retries: 3 });

await mapper.resolveNsuidToAppId(nsuid, 'GB', {
  timeoutMs: 8_000,
  retries: 1,
});
```

`timeoutMs` can override both Savanna and redirector requests per call. On either
upstream, attempts share that request's timeout budget; retries never silently multiply it.
A map can make multiple requests, so this is not a whole-map deadline. Pass an
`AbortSignal` when the complete mapping operation needs one.

## Resolving ids

Both directions, and both batched.

| Direction     | Method                                          |
| ------------- | ----------------------------------------------- |
| nsuid → appId | `resolveNsuidToAppId` / `resolveNsuidsToAppIds` |
| appId → nsuid | `resolveAppIdToNsuid` / `resolveAppId`          |

```ts
// One request, whatever the kinds. Every id asked for is in the result.
const found = await mapper.resolveNsuidsToAppIds(
  ['70010000095202', '70050000056264', '70070000034970'],
  'JP',
);
// Map {
//   '70010000095202' => '040078001ccf6000',  title
//   '70050000056264' => '040078001ccf7003',  dlc
//   '70070000034970' => null,                bundle — has no appId of its own
// }
```

`null` is an answer, not a failure: bundles carry no application id, demos and
consumables have none at all, and an nsuid not sold in that catalog has nothing
to return. The lookup uses a selection of its own that asks only for the id, so
it does not pay for the bundle fingerprint `mapNsuid` needs.

### Region is the catalog, not the storefront

The fourteen regions share **four** catalogs. An nsuid resolves anywhere in its
own group and nowhere else, so any country in the right group will do:

| Catalog | Regions                                 |
| ------- | --------------------------------------- |
| JP      | `JP`                                    |
| NOA     | `US` `CA` `MX` `BR`                     |
| NOE     | `GB` `DE` `FR` `ES` `IT` `NL` `AU` `NZ` |
| HK      | `HK`                                    |

```ts
await mapper.resolveNsuidToAppId('70010000095203', 'US'); // '040078001ccf6000'
await mapper.resolveNsuidToAppId('70010000095203', 'MX'); // same — same catalog
await mapper.resolveNsuidToAppId('70010000095203', 'JP'); // null — different one
```

Measured 2026-07-23 for these samples. `AU` shares the NOE catalog in these
lookups; a catalog group does not guarantee identical availability for every product.

Set `defaultRegion` on the constructor to omit the argument.

### Multi-SKU titles

One appId can list as several products in a region — a Switch 1 release and its
Switch 2 Edition, for instance. `enumerateSkus` walks `acdIndex` until the
redirect repeats index 0:

```ts
await mapper.enumerateSkus('0100453019aa8000', 'JP');
// [ { nsuid: '70010000088831', … },   HAC
//   { nsuid: '70010000116668', … } ]  BEE, Switch 2 Edition
```

`buildUrl` builds the entry URL without a request.

## Development

Development and tests use Bun. The build, type-check, lint and formatting
scripts explicitly run their JavaScript tools with Bun, including tools whose
launcher specifies Node.js. A separate Node.js installation is not required.

The compiled ESM library uses standard JavaScript and Web APIs. Its Node.js
compatibility declaration starts at 18.17 because cancellation uses
`AbortSignal.any()`; this is a requirement for Node.js consumers, not Bun users.

```bash
git clone https://github.com/maixiang-sh/nsuid-mapper.git
cd nsuid-mapper
bun install --frozen-lockfile
bun run check      # build, types, lint, format, offline tests
bun run test:live  # the real endpoints
LIVE=1 bun test tests/  # the complete suite, including real endpoints
```

Live tests retry once after a timeout, network error, HTTP 429 or HTTP 5xx,
and print the retry reason. A second failure still fails the test. Assertions,
schema errors and caller cancellation are not retried. This test-only retry
does not change the SDK's request timeout or automatic retry policy.

## SKU identity and upgrades

`resolveAppIdToNsuid` still returns the redirector's default SKU (`acdIndex=0`).
`mapNsuid` checks that the source has an application ID, platform and rights before
requesting target countries. It verifies the source and target platform and complete
sorted title-right set.
It examines the default target plus the base/upgrade titles linked by `upgradeInfo`.
It returns an unmapped result with a reason when the evidence is missing, no candidate
fits, or several candidates match; it never substitutes the ordinary edition for a
Switch 2 Edition. Unlinked variants are not guessed from an index or name.

Upgrade DLC is searched through `upgradeInfo.upgradeDlcItem` as well as `dlcItems`,
using the platform and full DLC right set to verify the match. Request cancellation and timeout
remain non-retryable even when they occur while reading the response body.

### Bundle regression fixtures

`tests/fixtures/bundles.json` and `tests/fixtures/dlcs.json` store only the minimal mapping fields from real
Nintendo responses verified on 2026-10-11. Offline tests cover edition mix-ups,
non-searchable members, multi-right DLC, repeated members, ambiguous candidates
and scan caps. Consumable fixtures cover The Crew's three editions, FC 26's nine
US bundles with identical member counts, and NBA 2K26's different regional group
IDs. Missing identities and exact `itemId` comparisons have regression coverage.
Request tests cover HTTP errors envelopes, malformed JSON, redirector retry recovery /
exhaustion, cancellation during backoff, source preflight and per-call timeout overrides. Synthetic mutations are marked in tests. Live regressions verify
both correct mappings and explicit refusal when current upstream evidence is
insufficient. Live assertions are dated observations; future catalog changes
can require updating them after verification.
