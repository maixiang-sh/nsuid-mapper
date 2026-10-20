# nsuid-mapper

[中文](README.zh-CN.md)

Find the same Nintendo eShop product in other countries.

This is an unofficial tool. It is not affiliated with or endorsed by Nintendo.

## The problem

Every product in the Nintendo eShop has an **NSUID**, a 14-digit product number.
The same game usually has a different NSUID in each country:

| Street Fighter 6 | NSUID            |
| ---------------- | ---------------- |
| Japan            | `70010000095202` |
| United States    | `70010000095203` |
| United Kingdom   | `70010000095204` |
| Hong Kong        | `70010000095206` |

Nintendo offers no way to ask "what is this product's number in another country?".
This library answers that question, for games, DLC, bundles and demos.

## How it works, briefly

Two public Nintendo services are combined:

1. Nintendo's product data service (called **Savanna**) tells us what a product
   is: its game ID, its platform, and exactly which content it includes.
2. A Nintendo **redirect link** turns a game ID into that game's product page in
   any country, and the page address contains that country's NSUID.

The library reads the product in the source country, follows the redirect link to
the target country, reads the products found there, and returns a result only when
exactly one of them is the same product. It never matches by name.

[How it works](docs/how-it-works.md) explains each step and each Nintendo service.

## Quick start

Requires [Bun](https://bun.sh). The library has no runtime dependencies.

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

Each target has either an `nsuid`, or a `code` and a `reason` explaining why there
is none. Check `code` in your program; `reason` is for people to read.

To use it from another project, run `bun run build` and add this folder as a local
dependency named `nsuid-mapper`. It is not published to npm.

## What can be mapped

| NSUID starts with | Product type | Supported                                              |
| ----------------- | ------------ | ------------------------------------------------------ |
| `7001`            | Game         | Yes                                                    |
| `7005`            | DLC          | Yes                                                    |
| `7007`            | Bundle       | Yes                                                    |
| `7003`            | Demo         | Yes, when its game lists only one demo on its platform |
| `7009`            | Consumable   | No, e.g. in-game currency                              |
| `7002`, `7008`    | Tickets      | No                                                     |

Some products cannot be mapped even when they exist in both countries. The result
then explains why instead of guessing:

- **The game uses a different ID in another region.** For example, Monster Hunter
  Rise has one ID in Japan and Hong Kong and another in the US and Europe.
- **Several products look identical in Nintendo's data**, such as DLC packs that
  unlock the same content.
- **The product is no longer sold** in the target country. Nintendo's product
  lists leave out delisted items, so they cannot be found.

## Countries

Works for 45 countries, including Japan, Hong Kong, the US, Canada, Mexico, Brazil,
the UK, Australia, New Zealand and most of Europe. Korea, Taiwan, mainland China,
Southeast Asia, parts of the Middle East and Latin America, and the Caribbean do
not work: Nintendo's redirect link does not lead to a product page there. See the
[full country list](docs/reference.md#country-list).

Countries are written as two-letter codes such as `JP`, `US` or `GB`. One call maps
one product into at most 8 countries.

## Options

```ts
const mapper = new NsuidMapper({
  timeoutMs: 15_000, // per request to Nintendo; default 10 seconds
  retries: 2, // extra tries after network errors or server overload; default 2
});

await mapper.mapNsuid('70070000040805', {
  from: 'HK',
  to: ['JP', 'US'],
  signal: AbortSignal.timeout(30_000), // a time limit for the whole call
});
```

A failed request to Nintendo throws an `NsuidMapError` after the retries. All
methods, options, result codes and errors are listed in the
[reference](docs/reference.md).

## Development

```bash
bun run check      # build, type check, lint, format check and offline tests
bun run test:live  # tests against Nintendo's real services
bun run example    # runs examples/basic.ts, also against the real services
```

## Documents

- [How it works](docs/how-it-works.md): the idea, the Nintendo services used, and the steps for each product type
- [Reference](docs/reference.md): methods, options, result codes, errors and request costs

## License

[MIT](LICENSE)
