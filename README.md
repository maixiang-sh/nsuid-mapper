# @nintendo-store/nsuid-mapper

[中文说明](README.zh-CN.md) · [Technical design](docs/technical-design.zh-CN.md) · [Redirector protocol](docs/apps-redirector.md)

Map a Nintendo eShop NSUID to the same product in other countries. This independent
Bun + TypeScript library uses public Nintendo endpoints and has no runtime dependencies.
It is not an official Nintendo SDK.

## Getting started

```bash
git clone https://github.com/maixiang-sh/nsuid-mapper.git
cd nsuid-mapper
bun install --frozen-lockfile
bun run build
```

Inside the checkout, import the source directly:

```ts
import { NsuidMapper } from './src/index.ts';

const mapper = new NsuidMapper();
const result = await mapper.mapNsuid('70010000095202', {
  from: 'JP',
  to: ['HK', 'US', 'GB'],
});
console.log(result.targets);
// Each target contains region and either nsuid or an unmapped reason.
```

In a consuming project, use the package name `@nintendo-store/nsuid-mapper`
after adding the built checkout as a local dependency. No npm publication is required.

## Mapping and limits

| Kind          | Identity used for matching                                                            |
| ------------- | ------------------------------------------------------------------------------------- |
| Title `7001`  | Application ID, platform and complete ROM rights, including linked edition candidates |
| DLC `7005`    | Platform and complete rights; candidates come from the parent DLC and upgrade lists   |
| Bundle `7007` | Platform, complete rights and every member's identity, including repeated members     |
| Demo `7003`   | Its parent title's identity and platform; the title must list exactly one such demo   |

Consumable bundle members use their exact `itemId` and publisher ID. Names and
localized descriptions do not participate in matching.

A demo has no application ID or rights of its own. It maps through the titles
upstream lists as its parents: each parent is mapped as a title, and the target
title's demo list supplies the candidate. The source and target titles must each
list exactly one demo on the demo's platform; otherwise the result is ambiguous.
This is weaker evidence than rights, and it is the only public evidence there is.

Standalone consumables `7009` have no supported target discovery path. Catalog tickets `7002` and normal tickets `7008` are recognized but not mapped.
Missing identity evidence, ambiguous candidates and incomplete scans return a reason.
Regional builds with different application IDs cannot be joined without an upstream link.
A missing redirect does not establish that a product is unavailable in that country.

An unresolved parent anchor is skipped. Each returned candidate must match the full
source identity, but uniqueness applies only within the resolved parents' candidate
lists, not the entire regional catalog. Network and schema failures still throw.

Each `mapNsuid` call accepts one NSUID and up to eight distinct target countries.
Countries run concurrently; parents within one country are scanned sequentially.
Parent and pagination limits prevent accepting matches from unfinished scans.
Rules, request costs and verified counterexamples live in the
[technical design](docs/technical-design.zh-CN.md).

## Other methods

| Method                                         | Result                                                          |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `resolveNsuidToAppId(nsuid, region)`           | One representative application/right ID, or `null`              |
| `resolveNsuidsToAppIds(nsuids, region)`        | A `Map` of representative IDs for a same-catalog batch          |
| `resolveAppIdToNsuid(appId, region, options?)` | Default redirect target, or `null`; does not verify the edition |
| `resolveAppId(appId, region, options?)`        | The target and redirect metadata                                |
| `enumerateSkus(appId, region, options?)`       | Candidate title SKUs reached through `acdIndex`                 |
| `buildUrl(appId, region, acdIndex?)`           | Entry URL without making a request                              |

Use `mapNsuid` when edition identity matters. An ID-only lookup is not a complete
SKU comparison; bundles have no application ID of their own. Set `defaultRegion`
on the constructor to omit the region argument from ID lookups.

Batch lookups send the input in one request. The client has no batch cap, but the
upstream maximum is unknown. Split large inputs into modest sequential batches,
for example 100 IDs. Country catalog sharing is an observation, not a guarantee
of identical availability for every product.

`contextFor(country)` selects the recorded default Savanna language.
`getCountryLanguageInfo` and `isCountryLanguageSupported` expose the configured
language snapshot; it does not guarantee translated text or product availability.
KR/TW redirector limitations are observations, so requests are not permanently blocked.

## Requests and errors

```ts
const mapper = new NsuidMapper({ timeoutMs: 15_000, retries: 2 });
await mapper.mapNsuid('70070000040805', {
  from: 'HK',
  to: ['JP', 'US', 'GB', 'AU'],
  signal: AbortSignal.timeout(30_000),
});
```

- `timeoutMs`: integer milliseconds from 1 to 120000, default 10000. It covers
  one upstream request, including response reads, retries and backoff. Use `signal`
  for a deadline covering an entire multi-request mapping.
- `retries`: extra attempts for network errors and HTTP 429/5xx, default 2,
  capped at 5; `0` disables retries. Backoff uses jitter.
- `Retry-After`: integer seconds or an HTTP date, treated as a minimum wait.
  If the server's wait cannot fit in the remaining budget, the original error
  is thrown immediately, preserving `status` and `retryAfterMs`. `retryable: true`
  means a caller may retry later; it does not mean this call will keep retrying.
- Cancellation or an actually expired deadline returns `kind: 'abort'` or
  `'timeout'`. Both stop retries and clear timers. Buffered responses are checked
  before being returned, so cancellation is not lost.

Defaults can be overridden per call. Both upstreams also accept custom `headers`
and an injectable `fetch`. Invalid timeout values throw `TypeError` before fetching.
HTTP, GraphQL, malformed responses and cancellation use `NsuidMapError`; a hard
failure in one target country rejects the whole `mapNsuid` call.

An unmapped target instead has a human-readable `reason`. Check whether `nsuid`
is present rather than parsing that text. The [reason reference](docs/technical-design.zh-CN.md#未映射原因)
explains the distinction between missing candidates, ambiguity and unfinished scans.

## Custom product queries

The exported `execute`, `contextFor` and `SHOP_ID` helpers allow caller-written
Savanna selections. A complete example is in [examples/basic.ts](examples/basic.ts).
Selections must match the upstream object type; an invalid field can reject the
whole query. `labelPlatform`, rather than `platform.id`, distinguishes editions
in the mapping identity.

## Public exports

The package root exposes 18 runtime symbols, with no additional subpath entry points:

| Purpose                      | Exports                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Client and errors            | `NsuidMapper`, `NsuidMapError`, `MAX_REGIONS_PER_MAP`                                                                             |
| ID and URL helpers           | `isAppId`, `isCatalogId`, `parseAppId`, `parseNsuid`, `itemKindFromNsuid`, `deriveBaseApplicationIdFromDlcAppId`, `buildAppIdUrl` |
| Country context              | `contextFor`, `getCountryLanguageInfo`, `isCountryLanguageSupported`, `isMappable`                                                |
| Advanced queries and mapping | `execute`, `SHOP_ID`, `fetchIdentities`, `mapInto`                                                                                |

Input and result types remain exported, including `NsuidMapperOptions`, `MapOptions`,
`RequestOptions`, `ResolveOptions`, `EnumerateOptions`, `NsuidMapping`, `RegionMapping`,
`Identity`, `IdentityKind` and `AppIdResolver`. Types do not add runtime exports.

Prefer `mapper.mapNsuid` for normal use. `fetchIdentities` plus `mapInto` supports
reading the source identity once and handling target errors independently, as existing
consumers do. These lower-level functions do not provide the client's input validation
or target-count limit; callers must validate IDs/context and bound their own fan-out.
`isMappable` describes a historical coverage snapshot and allows unknown countries;
it is not a product-availability check.

### Migrating from the previous root exports

This is a breaking reduction of the root export surface. Client methods and matching
behavior are unchanged. Existing vendored copies are not automatically updated.

| Removed exports                                                                                                        | Replacement or guidance                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `isNsuid`                                                                                                              | `isCatalogId`; the deprecated alias has been deleted                                                                                        |
| `fetchAppIds`                                                                                                          | `mapper.resolveNsuidsToAppIds`                                                                                                              |
| `normalizeRegion`                                                                                                      | `contextFor(region).country` for validated, normalized country codes                                                                        |
| `parseAcdIndex`                                                                                                        | Pass the index to `buildAppIdUrl` or client methods, which validate it                                                                      |
| `COMMON_REGIONS`, `CommonRegion`                                                                                       | Use explicit country strings; the duplicate list has been deleted                                                                           |
| `MAPPABLE_COUNTRIES`, `UNMAPPABLE_COUNTRIES`, `MAPPABLE_COUNTRY_LANGUAGES`, `isKnownMappable`                          | Use `isMappable` for the known-dead-end policy, and the language helpers for context; these are not equivalent to enumerating the old lists |
| `DEFAULT_ENUMERATE_MAX`, `MAX_ENUMERATE_LIMIT`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_HEADERS`, `EC_BASE`, `SAVANNA_ENDPOINT` | Defaults and endpoint details are internal; configure client/request options when needed                                                    |
| `extractNsuidFromLocation`, `parseStorefrontPath`, `pathKindFromSegment`, `collectContentAppIds`                       | Internal parsers; use client results or `fetchIdentities`                                                                                   |
| `MappableKind`                                                                                                         | Use `IdentityKind` when describing returned identities; it also includes unsupported kinds                                                  |

Do not replace these imports with deep imports into `src/` or `dist/`; those paths
are implementation details rather than supported package entry points.

## Development

Development uses Bun 1.4.3 and TypeScript 7.0.2. The built ESM library also supports
Node.js 18.17+, whose `AbortSignal.any()` is used for cancellation.

```bash
bun run check          # build, typecheck, lint, formatting and offline tests
bun run test:live      # real Nintendo API requests
bun run example        # runnable examples; also makes real requests
LIVE=1 bun test tests/ # offline and live tests together
```

Live tests retry transient failures once; assertion and schema failures are not
retried. Recorded identity fixtures are small, and synthetic mutations are marked.
The [technical design](docs/technical-design.zh-CN.md#验证样本) links to regression
cases and explains their evidence and limitations.

## License

[MIT](LICENSE)
