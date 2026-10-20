# Reference

[中文](reference.zh-CN.md) · [README](../README.md) · [How it works](how-it-works.md)

Countries are two-letter codes such as `JP`, `US` or `GB`; lowercase is accepted.
NSUIDs may be strings or numbers.

## mapNsuid

```ts
const result = await mapper.mapNsuid(nsuid, { from, to, ...requestOptions });
```

| Option                   | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `from`                   | The country the NSUID belongs to. An NSUID can only be read in its own country. |
| `to`                     | Up to 8 target countries. Repeated countries count once.                        |
| `signal`, `timeoutMs`, … | [Request options](#request-options)                                             |

The result:

```ts
{
  source: { region, nsuid, kind, code?, reason?, … }, // the product as read in `from`
  targets: [{ region, nsuid?, code?, reason? }],       // one entry per target country, in order
}
```

- `targets[i].nsuid` is present when the product was found.
- Otherwise `code` gives the [category](#result-codes) and `reason` a sentence for
  people. Program against `code`; the wording of `reason` may change.
- `source.kind` is `title`, `dlc`, `bundle`, `demo`, `consumable` or `unknown`.
  When the source itself cannot be mapped, `source` carries the same `code` and
  `reason`, and no target country is contacted.
- The other `source` fields (game ID, platform, content rights, bundle members)
  are the data used for comparison.

## Result codes

| Code                    | Meaning                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `source_not_found`      | The source country did not return this NSUID. It may belong to another country.                                             |
| `unsupported`           | This product type cannot be mapped: consumables, tickets, unknown types, or a bundle with a member that cannot be compared. |
| `insufficient_identity` | Nintendo's data is missing something the comparison needs, such as the platform or content rights.                          |
| `unresolved`            | The redirect link found no product for the game ID in the target country.                                                   |
| `no_candidates`         | The target country listed nothing to compare.                                                                               |
| `no_match`              | Products were found, but none is the same product.                                                                          |
| `ambiguous`             | More than one product matches, and the data cannot tell them apart.                                                         |
| `incomplete`            | A search stopped at a limit before finishing, so a match could not be confirmed.                                            |

None of these prove the product is not sold in the target country. In particular,
lists leave out delisted products, so a delisted product shows up as
`no_candidates` or `no_match`, and a game that uses a different ID in another
region shows up as `unresolved`.

## Other methods

| Method                                       | Returns                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `resolveNsuidToAppId(nsuid, country)`        | The game ID, or `null`. Bundles, demos and consumables have none. |
| `resolveNsuidsToAppIds(nsuids, country)`     | A `Map` from each NSUID to its game ID or `null`, in one request  |
| `resolveAppIdToNsuid(appId, country)`        | The NSUID the redirect link leads to, or `null`                   |
| `resolveAppId(appId, country, { acdIndex })` | The same, with the redirect address and the path type             |
| `enumerateSkus(appId, country, { max })`     | Every product the redirect link can lead to for this game ID      |
| `buildUrl(appId, country, acdIndex?)`        | The redirect link itself, without making a request                |

Notes:

- These are lookups, not mappings. The game ID returned for a DLC is one of its
  content IDs, and the redirect link returns one product even when a game ID has
  several. Use `mapNsuid` when the exact edition matters.
- All NSUIDs passed to `resolveNsuidsToAppIds` must come from one country's store.
  There is no size limit in the library, but Nintendo's limit is unknown; send
  large lists in batches of about 100.
- `acdIndex` picks among the products of one game ID, starting at 0. It is a
  position, not a platform. `enumerateSkus` tries 0, 1, 2… until a product repeats;
  `max` defaults to 16 and may be at most 32.
- Set `defaultRegion` on the client to leave out the country argument.

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

| Option                | Meaning                                                                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| `timeoutMs`           | Default time limit for each request. See [request options](#request-options).         |
| `retries`             | Default number of retries                                                             |
| `headers`             | Extra request headers for both Nintendo services, replacing defaults of the same name |
| `fetch`               | Replacement `fetch` function, for example in tests                                    |
| `defaultRegion`       | Country used when a lookup method is called without one                               |
| `defaultEnumerateMax` | Default `max` for `enumerateSkus`                                                     |
| `baseUrl`             | Host of the redirect link, default `https://ec.nintendo.com`                          |

## Request options

Every method accepts these as its last argument. They override the client options.

| Option      | Meaning                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `timeoutMs` | Time limit for one request to Nintendo, including its retries. Whole milliseconds from 1 to 120000; default 10000. |
| `retries`   | Extra tries after a failure that may be temporary. Default 2, at most 5; `0` turns retries off.                    |
| `signal`    | An `AbortSignal` to cancel the whole call, for example `AbortSignal.timeout(30_000)`.                              |
| `headers`   | Extra request headers                                                                                              |
| `fetch`     | Replacement `fetch` function                                                                                       |

One mapping makes several requests, and `timeoutMs` applies to each of them.
Use `signal` to limit the whole call.

**What is retried:** network errors, HTTP 429 (too many requests) and HTTP 5xx
(server errors). The wait between tries grows each time, with some randomness.
If Nintendo sends a `Retry-After` header, the library waits at least that long;
if that wait does not fit in the remaining time, it stops at once and throws the
original error. Other errors are not retried.

Invalid input, such as a malformed NSUID, an unknown country format, more than
8 target countries or an invalid `timeoutMs`, throws a `TypeError` before any request.

## Errors

A request that still fails after its retries throws an `NsuidMapError`:

| Field          | Meaning                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| `kind`         | `network`, `timeout`, `abort` (cancelled), `http`, `graphql`, `response` (unreadable reply) or `other` |
| `status`       | The HTTP status, when there was a response                                                             |
| `url`          | The address requested                                                                                  |
| `retryable`    | `true` if trying again later may help                                                                  |
| `retryAfterMs` | The wait Nintendo asked for, in milliseconds, when it sent `Retry-After`                               |

If any target country fails this way, the whole `mapNsuid` call throws. To keep
the other countries' results, map each country separately with the
[low-level functions](#low-level-functions).

## Request costs

`mapNsuid` sends one Savanna request for the source product, then for each target
country:

| Product type | Requests per target country                                                                 |
| ------------ | ------------------------------------------------------------------------------------------- |
| Game, demo   | 1 redirect + 1 Savanna                                                                      |
| DLC          | 1 redirect per game + 1 Savanna per 100 DLC listed                                          |
| Bundle       | 1 redirect per game + 1 Savanna per 100 items listed, for each game and its linked editions |

Most products have one game, so most mappings cost 2 requests per country. Target
countries run at the same time; within one country, requests run one after another.
A search reads at most 16 games and 40 pages per game.

## Country list

These lists come from a test of every country Nintendo's data service knows,
made on 2026-07-23 with four widely sold games. Nintendo can change them at any
time, and a supported country does not mean every product is sold there.

### Supported (45)

| Region                     | Countries                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asia (2)                   | Japan `JP`, Hong Kong `HK`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Americas (8)               | United States `US`, Canada `CA`, Mexico `MX`, Brazil `BR`, Argentina `AR`, Chile `CL`, Colombia `CO`, Peru `PE`                                                                                                                                                                                                                                                                                                                                            |
| Europe (31)                | United Kingdom `GB`, Ireland `IE`, Germany `DE`, Austria `AT`, Switzerland `CH`, France `FR`, Belgium `BE`, Luxembourg `LU`, Netherlands `NL`, Italy `IT`, Spain `ES`, Portugal `PT`, Denmark `DK`, Sweden `SE`, Norway `NO`, Finland `FI`, Poland `PL`, Czechia `CZ`, Slovakia `SK`, Hungary `HU`, Romania `RO`, Bulgaria `BG`, Croatia `HR`, Slovenia `SI`, Greece `GR`, Cyprus `CY`, Malta `MT`, Estonia `EE`, Latvia `LV`, Lithuania `LT`, Russia `RU` |
| Oceania (2)                | Australia `AU`, New Zealand `NZ`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Africa and Middle East (2) | South Africa `ZA`, Israel `IL`                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Not supported (47)

The redirect link leads to a general store page, an empty page or "not found"
in these countries, so no product can be found there.

| Region                         | Countries                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| East Asia (3)                  | South Korea `KR`, Taiwan `TW`, Mainland China `CN`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Southeast Asia (4)             | Malaysia `MY`, Philippines `PH`, Singapore `SG`, Thailand `TH`                                                                                                                                                                                                                                                                                                                                                                                              |
| Middle East (3)                | United Arab Emirates `AE`, Saudi Arabia `SA`, Türkiye `TR`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Central and South America (15) | Bolivia `BO`, Belize `BZ`, Costa Rica `CR`, Ecuador `EC`, French Guiana `GF`, Guatemala `GT`, Guyana `GY`, Honduras `HN`, Nicaragua `NI`, Panama `PA`, Paraguay `PY`, Suriname `SR`, El Salvador `SV`, Uruguay `UY`, Venezuela `VE`                                                                                                                                                                                                                         |
| Caribbean (22)                 | Antigua and Barbuda `AG`, Anguilla `AI`, Aruba `AW`, Barbados `BB`, Bermuda `BM`, Bahamas `BS`, Dominica `DM`, Dominican Republic `DO`, Grenada `GD`, Guadeloupe `GP`, Haiti `HT`, Jamaica `JM`, Saint Kitts and Nevis `KN`, Cayman Islands `KY`, Saint Lucia `LC`, Martinique `MQ`, Montserrat `MS`, Turks and Caicos Islands `TC`, Trinidad and Tobago `TT`, Saint Vincent and the Grenadines `VC`, British Virgin Islands `VG`, U.S. Virgin Islands `VI` |

A country in neither list is still tried: the request finds out whether it works.

## Countries and languages

| Function                                    | Returns                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `isMappable(country)`                       | `false` for countries known not to work, such as `KR` or `TW`; `true` otherwise, including unknown codes |
| `contextFor(country)`                       | `{ country, language }`: the normalized code and the language used to query it                           |
| `getCountryLanguageInfo(country)`           | The country's default and available languages, or `undefined`                                            |
| `isCountryLanguageSupported(country, lang)` | Whether the language is listed for that country                                                          |

Countries in the same region often share NSUIDs, for example the UK and Australia.
That is common but not guaranteed, so always ask for the countries you need.

## Low-level functions

| Export                                               | Use                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `fetchIdentities`, `mapInto`                         | Read the source once, then map country by country and handle each failure separately |
| `execute`, `SHOP_ID`, `contextFor`                   | Send your own Savanna query, for example to read names or prices after mapping       |
| `isAppId`, `parseAppId`, `isCatalogId`, `parseNsuid` | Check and normalize IDs                                                              |
| `itemKindFromNsuid`                                  | The product type from an NSUID's first four digits                                   |
| `deriveBaseApplicationIdFromDlcAppId`                | The game ID behind a DLC content ID                                                  |
| `buildAppIdUrl`                                      | The redirect link, without a client                                                  |
| `MAX_REGIONS_PER_MAP`                                | The limit of 8 target countries                                                      |

`fetchIdentities` and `mapInto` skip the client's input checks and country limit.

```ts
import { contextFor, fetchIdentities, mapInto, NsuidMapper } from 'nsuid-mapper';

const mapper = new NsuidMapper();
const { country, language } = contextFor('JP');
const source = (await fetchIdentities([nsuid], country, language)).get(nsuid)!;
const results = await Promise.allSettled(
  ['US', 'GB', 'HK'].map((target) => mapInto(source, target, mapper)),
);
```

A complete custom query is in [examples/basic.ts](../examples/basic.ts). A field
Savanna does not recognize makes the whole query fail.
