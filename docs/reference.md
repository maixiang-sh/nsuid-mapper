# Reference

[中文](reference.zh-CN.md) · [README](../README.md) · [How it works](how-it-works.md)

Countries and regions are identified by two-letter ISO codes (`JP`, `US`, `GB`);
lowercase is accepted.
NSUIDs may be strings or numbers.

## mapNsuid

```ts
const result = await mapper.mapNsuid(nsuid, { from, to, ...requestOptions });
```

| Option                   | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `from`                   | Country or region of the source NSUID. An NSUID only resolves in its own store. |
| `to`                     | Up to 8 targets. Duplicates are removed.                                        |
| `targetErrors`           | `throw` (default) or `return`; see [errors](#errors).                           |
| `signal`, `timeoutMs`, … | See [request options](#request-options).                                        |

Result:

```ts
{
  source: { region, nsuid, kind, code?, reason?, … }, // source product as read in `from`
  // one entry per target, in order
  targets: [{ region, status, nsuid?, code?, reason?, candidates?, titles?, scope?, error? }],
}
```

- `status` says what the result means ([result status](#result-status)). A
  `mapped` target has `nsuid`; any other except `error` has `code` and `reason`.
  `code` says where mapping stopped ([result codes](#result-codes)); `reason`
  may be reworded.
- `candidates` appears only with `ambiguous`: the target NSUIDs that all matched,
  sorted. It is absent when the conflict is not between target products of the
  same kind — a demo whose source title lists several demos, or whose
  parent title is itself ambiguous, or an ambiguous source ticket group.
- `titles` appears when the product was not mapped but target titles were
  reached through its application IDs: the parent titles of a DLC, bundle or
  demo, or a title with the same application ID but another platform or ROM
  rights. Sorted. It identifies the same game, not the same product.
- `scope: 'source'` marks a result caused by the source product alone. Every
  target then has the same result.
- `source.kind`: `title`, `dlc`, `bundle`, `demo`, `ticket`, `consumable` or `unknown`.
- If the source cannot be mapped, `source` has the same `code` and `reason`, and no
  target is requested.
- Other `source` fields hold the identity used for comparison: application ID,
  platform, ROM rights and bundle members.
- `source.ticket` holds an ordinary time ticket's `groupId`, `publisherId`,
  `grantMinutes` and `subscriptionMinutes`. The latter is null when there is
  explicitly no associated subscription, otherwise its exact grant minutes.

## Result status

| `status`       | Meaning                                                            | `code`                                                    |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `mapped`       | `nsuid` is the one matching product.                               | —                                                         |
| `not_found`    | No same product was found. Usually stable.                         | `unresolved`, `no_candidates`, `no_match`                 |
| `ambiguous`    | Several products match, or the source relation is ambiguous.       | `ambiguous`                                               |
| `undetermined` | The available data cannot settle it yet; a later check may differ. | `source_not_found`, `insufficient_identity`, `incomplete` |
| `unsupported`  | This kind of product is not mapped. Checking again does not help.  | `unsupported`                                             |
| `error`        | A request failed. Only with `targetErrors: 'return'`; see `error`. | —                                                         |

## Result codes

| `code`                  | Meaning                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `source_not_found`      | The source store did not return the NSUID; it may belong to another store.                                                |
| `unsupported`           | Unsupported type: consumable, catalog voucher, subscription ticket, unknown type, or a bundle with an unsupported member. |
| `insufficient_identity` | Savanna omitted data needed for comparison, such as platform or ROM rights.                                               |
| `unresolved`            | The redirector returned no product for the application ID in the target store.                                            |
| `no_candidates`         | The target store returned no candidates.                                                                                  |
| `no_match`              | Candidates were returned; none has the same identity.                                                                     |
| `ambiguous`             | No single product can be picked; see `candidates` and `reason`.                                                           |
| `incomplete`            | A search reached a limit before finishing.                                                                                |

No code proves that a product is unavailable. Listings omit delisted products, so
a delisted product appears as `no_candidates` or `no_match`; a title with a
different application ID in the target region appears as `unresolved`.

See [Mapping outcomes and failure reasons](mapping-outcomes.md) for cause
categories, ambiguity examples and the distinction between mapping results and
execution errors.

## Other methods

| Method                                       | Returns                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `resolveNsuidToAppId(nsuid, country)`        | Application ID, or `null` (bundles, demos and consumables have none) |
| `resolveNsuidsToAppIds(nsuids, country)`     | `Map` of NSUID to application ID or `null`, in one request           |
| `resolveAppIdToNsuid(appId, country)`        | NSUID from the redirector, or `null`                                 |
| `resolveAppId(appId, country, { acdIndex })` | Same, with the redirect URL and path type                            |
| `enumerateSkus(appId, country, { max })`     | All products the redirector returns for the application ID           |
| `buildUrl(appId, country, acdIndex?)`        | Redirector URL, without a request                                    |

- These are lookups, not mappings. For a DLC the returned ID is its first ROM
  right, and the redirector returns one product per request. Use `mapNsuid` when
  the edition matters.
- `resolveNsuidsToAppIds` requires all NSUIDs to be from one store. The library
  sets no batch limit; Savanna's limit is unknown, so send about 100 per batch.
- `acdIndex` selects among the products of one application ID, starting at 0. It
  is a position, not a platform. `enumerateSkus` tries 0, 1, 2… until a product
  repeats; `max` defaults to 16, up to 32.
- With `defaultRegion` set on the client, the `country` argument may be omitted.

## Client options

```ts
new NsuidMapper({
  timeoutMs,
  retries,
  headers,
  fetch,
  defaultRegion,
  defaultEnumerateMax,
  baseUrl,
});
```

| Option                | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `timeoutMs`           | Default per-request timeout; see [request options](#request-options)   |
| `retries`             | Default retry count                                                    |
| `headers`             | Extra headers for both endpoints; override defaults with the same name |
| `fetch`               | Custom `fetch` implementation, e.g. for tests                          |
| `defaultRegion`       | Country or region used when a lookup method omits it                   |
| `defaultEnumerateMax` | Default `max` for `enumerateSkus`                                      |
| `baseUrl`             | Redirector host; default `https://ec.nintendo.com`                     |

## Request options

Accepted as the last argument of every method; they override client options.

| Option      | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `timeoutMs` | Timeout for one request, including its retries. Integer from 1 to 120000; default 10000. |
| `retries`   | Retries after a transient failure. Default 2, maximum 5; `0` disables retries.           |
| `signal`    | `AbortSignal` for the whole call, e.g. `AbortSignal.timeout(30_000)`.                    |
| `headers`   | Extra headers                                                                            |
| `fetch`     | Custom `fetch` implementation                                                            |

`timeoutMs` applies to each request, and one mapping sends several. Use `signal`
to limit the whole call.

Network errors, HTTP 429 and HTTP 5xx are retried with exponential backoff and
jitter. A `Retry-After` header sets the minimum wait; if that wait exceeds the
remaining timeout, the original error is thrown immediately. Other errors are not
retried.

Invalid input (malformed NSUID or country/region code, more than 8 targets,
invalid `timeoutMs`) throws `TypeError` before any request.

## Errors

A request that fails after its retries throws `NsuidMapError`:

| Field          | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `kind`         | `network`, `timeout`, `abort`, `http`, `graphql`, `response` or `other` |
| `status`       | HTTP status, if a response was received                                 |
| `url`          | Requested URL                                                           |
| `retryable`    | `true` if a later retry may succeed                                     |
| `retryAfterMs` | Wait requested by `Retry-After`, in milliseconds                        |

`abort` means the call was cancelled through `signal`; `response` means the reply
could not be parsed.

By default, a failed request for any target makes the whole `mapNsuid` call
throw. With `targetErrors: 'return'`, that target gets `status: 'error'` and an
`error` object with `kind`, `message`, `retryable`, and `status` and
`retryAfterMs` when known; the other targets keep their results. A failure
reading the source, invalid input and cancellation still throw.

## Request costs

`mapNsuid` sends one Savanna request for the source, then per target:

| Type                 | Requests per target                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Title, demo          | 1 redirector + 1 Savanna                                                                    |
| DLC                  | 1 redirector per parent title + 1 Savanna per 100 listed DLC                                |
| Bundle               | 1 redirector per parent title + 1 Savanna per 100 listed items per title and linked edition |
| Ordinary time ticket | 1 Savanna group query; no redirector                                                        |

Most products have one parent title, so most mappings need 2 requests per target.
Targets run concurrently; requests within a target run sequentially. A
search reads at most 16 parent titles and 40 pages per title.

## Countries and regions

Based on a 2026-07-23 test of all 92 countries and regions Savanna serves, using
four widely released titles. Nintendo may change this at any time. Support does
not guarantee that every product is sold there.

The table and `isMappable` describe redirector coverage. Ordinary time tickets
query Savanna directly and require a readable group with the same ID and
publisher; their coverage has not been measured across all countries.

### Supported (45)

| Area                       | Countries and regions                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asia (2)                   | Japan `JP`, Hong Kong `HK`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Americas (8)               | United States `US`, Canada `CA`, Mexico `MX`, Brazil `BR`, Argentina `AR`, Chile `CL`, Colombia `CO`, Peru `PE`                                                                                                                                                                                                                                                                                                                                            |
| Europe (31)                | United Kingdom `GB`, Ireland `IE`, Germany `DE`, Austria `AT`, Switzerland `CH`, France `FR`, Belgium `BE`, Luxembourg `LU`, Netherlands `NL`, Italy `IT`, Spain `ES`, Portugal `PT`, Denmark `DK`, Sweden `SE`, Norway `NO`, Finland `FI`, Poland `PL`, Czechia `CZ`, Slovakia `SK`, Hungary `HU`, Romania `RO`, Bulgaria `BG`, Croatia `HR`, Slovenia `SI`, Greece `GR`, Cyprus `CY`, Malta `MT`, Estonia `EE`, Latvia `LV`, Lithuania `LT`, Russia `RU` |
| Oceania (2)                | Australia `AU`, New Zealand `NZ`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Africa and Middle East (2) | South Africa `ZA`, Israel `IL`                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Not supported (47)

The redirector returns a generic store page, an empty page or 404 here.

| Area                           | Countries and regions                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| East Asia (3)                  | South Korea `KR`, Taiwan `TW`, Mainland China `CN`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Southeast Asia (4)             | Malaysia `MY`, Philippines `PH`, Singapore `SG`, Thailand `TH`                                                                                                                                                                                                                                                                                                                                                                                              |
| Middle East (3)                | United Arab Emirates `AE`, Saudi Arabia `SA`, Türkiye `TR`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Central and South America (15) | Bolivia `BO`, Belize `BZ`, Costa Rica `CR`, Ecuador `EC`, French Guiana `GF`, Guatemala `GT`, Guyana `GY`, Honduras `HN`, Nicaragua `NI`, Panama `PA`, Paraguay `PY`, Suriname `SR`, El Salvador `SV`, Uruguay `UY`, Venezuela `VE`                                                                                                                                                                                                                         |
| Caribbean (22)                 | Antigua and Barbuda `AG`, Anguilla `AI`, Aruba `AW`, Barbados `BB`, Bermuda `BM`, Bahamas `BS`, Dominica `DM`, Dominican Republic `DO`, Grenada `GD`, Guadeloupe `GP`, Haiti `HT`, Jamaica `JM`, Saint Kitts and Nevis `KN`, Cayman Islands `KY`, Saint Lucia `LC`, Martinique `MQ`, Montserrat `MS`, Turks and Caicos Islands `TC`, Trinidad and Tobago `TT`, Saint Vincent and the Grenadines `VC`, British Virgin Islands `VG`, U.S. Virgin Islands `VI` |

Codes in neither list are still requested.

## Country and region helpers

| Function                                    | Returns                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `isMappable(country)`                       | `false` for unsupported countries and regions; `true` otherwise, including unknown codes |
| `contextFor(country)`                       | `{ country, language }`: normalized code and the language used in queries                |
| `getCountryLanguageInfo(country)`           | Default and available languages, or `undefined`                                          |
| `isCountryLanguageSupported(country, lang)` | Whether the language is listed for that code                                             |

Stores in the same area often share NSUIDs (e.g. GB and AU), but not always.
Request every target you need.

## Low-level functions

| Export                                               | Use                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `fetchIdentities`, `mapInto`                         | Read the source once, then map and handle failures per target           |
| `execute`, `SHOP_ID`, `contextFor`                   | Send custom Savanna queries, e.g. to read names or prices after mapping |
| `isAppId`, `parseAppId`, `isCatalogId`, `parseNsuid` | Validate and normalize IDs                                              |
| `itemKindFromNsuid`                                  | Product type from the NSUID prefix                                      |
| `deriveBaseApplicationIdFromDlcAppId`                | Parent application ID of a DLC ID                                       |
| `buildAppIdUrl`                                      | Redirector URL without a client                                         |
| `MAX_REGIONS_PER_MAP`                                | Target limit (8)                                                        |

`fetchIdentities` and `mapInto` skip the client's input validation and target
limit.

```ts
import { contextFor, fetchIdentities, mapInto, NsuidMapper } from 'nsuid-mapper';

const mapper = new NsuidMapper();
const { country, language } = contextFor('JP');
const source = (await fetchIdentities([nsuid], country, language)).get(nsuid)!;
const results = await Promise.allSettled(
  ['US', 'GB', 'HK'].map((target) => mapInto(source, target, mapper)),
);
```

[examples/basic.ts](../examples/basic.ts) contains a complete custom query. An
unknown field makes Savanna reject the whole query.
