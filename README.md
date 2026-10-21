# nsuid-mapper

[中文](README.zh-CN.md)

Maps a Nintendo eShop NSUID to the NSUID of the same product in other countries and regions.

Unofficial project; not affiliated with or endorsed by Nintendo.

## Background

An NSUID is the 14-digit ID of a product in one country's or region's eShop. The
same product usually has a different NSUID in each:

| Street Fighter 6 | NSUID            |
| ---------------- | ---------------- |
| JP               | `70010000095202` |
| US               | `70010000095203` |
| GB               | `70010000095204` |
| HK               | `70010000095206` |

Nintendo provides no API for looking up a product's NSUID in another country or region.

## How it works

The library combines two public Nintendo endpoints:

- **Savanna**, the GraphQL API behind the web eShop, returns a product's
  application ID, platform and ROM rights.
- **The `/apps` redirector** (`ec.nintendo.com/apps/{applicationId}/{country}`)
  redirects to the product page in that country or region. The redirect URL
  contains the NSUID.

For each target, the redirector locates candidate products, and their
Savanna data is compared with the source product. A result is returned only when
exactly one candidate has the same identity. Names are never compared.

See [How it works](docs/how-it-works.md) for the endpoints and each step.

## Quick start

Requires [Bun](https://bun.sh). No runtime dependencies.

```bash
git clone https://github.com/maixiang-sh/nsuid-mapper.git
cd nsuid-mapper
bun install
```

```ts
import { NsuidMapper } from './src/index.ts';

const mapper = new NsuidMapper();
const result = await mapper.mapNsuid('70010000095202', {
  from: 'JP',
  to: ['US', 'GB', 'HK', 'KR'],
});
console.log(result.targets);
```

```js
[
  { region: 'US', nsuid: '70010000095203' },
  { region: 'GB', nsuid: '70010000095204' },
  { region: 'HK', nsuid: '70010000095206' },
  {
    region: 'KR',
    code: 'unresolved',
    reason: 'The application ID could not be resolved in the target region; …',
  },
];
```

Each target has either `nsuid`, or `code` and `reason`. Branch on `code`; `reason`
is for humans and its wording may change.

The library is not published to npm. To use it from another project, install it
from GitHub, pinned to a commit:

```bash
bun add github:maixiang-sh/nsuid-mapper#<commit>
```

A GitHub install contains the TypeScript source but no build output, so import
`nsuid-mapper/source` with a tool that compiles TypeScript, such as Bun or Wrangler:

```ts
import { NsuidMapper } from 'nsuid-mapper/source';
```

## Supported products

| NSUID prefix   | Type       | Supported                                         |
| -------------- | ---------- | ------------------------------------------------- |
| `7001`         | Title      | Yes                                               |
| `7005`         | DLC        | Yes                                               |
| `7007`         | Bundle     | Yes                                               |
| `7003`         | Demo       | Yes, if its title lists one demo on that platform |
| `7009`         | Consumable | No                                                |
| `7002`, `7008` | Ticket     | No                                                |

A product sold in both places may still be unmapped. The result then gives the
reason instead of a guess. Common causes:

- The title uses different application IDs in different stores, e.g. Monster
  Hunter Rise in JP/HK and in US/EU.
- Several products have identical identity data, e.g. DLC with the same ROM rights.
- The product is delisted in the target store, and Nintendo's listings omit it.

## Countries and regions

45 countries and regions are supported, including JP, HK, US, CA, MX, BR, GB, AU, NZ and most
of Europe. KR, TW, mainland China, Southeast Asia, parts of the Middle East and
Latin America, and the Caribbean are not: the redirector returns no product page
there. See the [full list](docs/reference.md#countries-and-regions).

Each is identified by a two-letter ISO code such as `JP`, `US` or `GB`. One call
accepts up to 8 targets.

## Options

```ts
const mapper = new NsuidMapper({
  timeoutMs: 15_000, // per request; default 10000
  retries: 2, // retries after network errors, HTTP 429 or 5xx; default 2
});

await mapper.mapNsuid('70070000040805', {
  from: 'HK',
  to: ['JP', 'US'],
  signal: AbortSignal.timeout(30_000), // limit for the whole call
});
```

A request that still fails after its retries throws `NsuidMapError`. See the
[reference](docs/reference.md) for all methods, options, result codes and errors.

## Development

```bash
bun run check      # build, typecheck, lint, format check, offline tests
bun run test:live  # tests against Nintendo's live endpoints
bun run example    # runs examples/basic.ts against the live endpoints
```

## Documentation

- [How it works](docs/how-it-works.md): terms, Nintendo endpoints, steps per product type
- [Reference](docs/reference.md): methods, options, result codes, errors, request costs, countries and regions

## License

[MIT](LICENSE)
