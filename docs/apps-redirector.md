# AppID redirector protocol

`GET https://ec.nintendo.com/apps/{appId}/{REGION}[?acdIndex=N]`

This public endpoint needs no login and returns redirect headers, not JSON.
The client uses `redirect: 'manual'` and reads only the first hop, avoiding
regional store queues and marketing redirects. Matching rules and dated product
observations are maintained in [the technical design](technical-design.zh-CN.md).

## Request

| Input      | Meaning                                                                |
| ---------- | ---------------------------------------------------------------------- |
| `appId`    | A 16-hex application ID; normalized to lowercase                       |
| `REGION`   | Uppercase two-letter country code; lowercase may return generic HTML   |
| `acdIndex` | Optional non-negative safe integer, default 0; selects a candidate SKU |

```ts
import { buildAppIdUrl, NsuidMapper } from 'nsuid-mapper';

buildAppIdUrl('0100453019aa8000', 'JP', { acdIndex: 1 });
// https://ec.nintendo.com/apps/0100453019aa8000/JP?acdIndex=1
```

The public Savanna selections `applicationItem(applicationId: ...)` and
`dlcItem(titleId: ...)` were rejected in earlier probes; they cannot substitute
for this reverse lookup.

## Responses

| Response                                        | Client result                        |
| ----------------------------------------------- | ------------------------------------ |
| Redirect with a product NSUID in `Location`     | Parsed product and redirect metadata |
| Redirect to a generic store page, with no NSUID | `null`                               |
| HTTP 200 without a product redirect             | `null`                               |
| HTTP 404                                        | `null`                               |
| Redirect missing `Location`                     | Error without retry                  |
| HTTP 429 / 5xx                                  | Retryable HTTP error                 |

Observed `Location` shapes include:

```text
/JP/ja/titles/70010000088831
https://www.nintendo.com/pos-redirect/70010000088832?l=en&c=US
https://www.nintendo-europe.com/redirect/?nsuid=70010000088833&country=GB&language=en
```

Relative storefront paths have the shape `/{REGION}/{language}/{kind}/{nsuid}`.
Recognized path kinds are `titles`, `aocs`, `bundles` and `demos`. These are URL
shapes, not a guarantee that `/apps` can discover every product kind.
`redirectUrl` is the absolute first-hop target, not necessarily the final store URL.

KR may redirect to a generic store and TW may return HTML without a redirect.
These observations do not prove a game is unavailable, and are not permanent
country exclusions in the client.

## Candidate selection with acdIndex

One application ID can resolve to multiple catalog products. `acdIndex` is an
index, not a platform selector: 0 does not always mean HAC, nor 1 always BEE.
Out-of-range indices may repeat the default SKU.

- `resolveAppIdToNsuid` returns the default candidate's NSUID.
- `resolveAppId` accepts an explicit index and returns the redirect metadata.
- `enumerateSkus` stops on a missing result or repeated NSUID. The default cap
  is 16 candidates, with a supported maximum of 32.
- `mapNsuid` verifies candidates using source platform and rights, including
  explicit upgrade links; a redirect alone does not prove the edition matches.

Examples are executable with `bun run example`. Error handling, retry budgets and
cancellation are documented in the [README](../README.md#requests-and-errors).

## Product identity

The entry resolves application IDs to title products. A DLC content ID generally
returns 404; a demo title ID obtained elsewhere can resolve to its parent title.
Neither result identifies the original DLC or demo NSUID. Consumables expose no
application anchor usable through this entry.

For DLC IDs in the AOC allocation range, derive the parent application by clearing
the low 13 bits, then discover and compare the target parent's DLC candidates:

```ts
import { deriveBaseApplicationIdFromDlcAppId } from 'nsuid-mapper';

const parent = deriveBaseApplicationIdFromDlcAppId('0100616025b6d002');
// 0100616025b6c000
```

The helper validates the content offset before applying `BigInt(id) & ~0x1fffn`.
The mapper uses every source right and requires a unique complete identity match.
[Technical design and samples](technical-design.zh-CN.md#本体与-dlc) explain why
parent derivation alone is insufficient to choose a target DLC.
