# AppID 跨区入口（ec.nintendo.com/apps）

**Package:** `nintendo-store-nsuid-mapper`
**Entry:** `GET https://ec.nintendo.com/apps/{appId}/{REGION}`
**Auth:** none
**Last verified:** 2026-07-23

Not an official Nintendo SDK. This is a **redirect gateway**, not a JSON API.

---

## 1. Why this exists

Savanna public GraphQL **cannot** reverse AppID → NSUID:

| Attempt                                   | Result  |
| ----------------------------------------- | ------- |
| `applicationItem(applicationId: "0100…")` | **400** |
| `dlcItem(titleId: "…")`                   | **400** |

Unified public substitute used by the storefront:

```text
https://ec.nintendo.com/apps/{appId}/{REGION}
```

Server responds with **307** + `Location` pointing at the **regional product page**.
Parse `Location` → 14-digit **nsuid**.

---

## 2. Request

```http
GET /apps/{appId}/{REGION}[?acdIndex=N] HTTP/2
Host: ec.nintendo.com
```

| Segment / param | Rules                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `appId`         | 16-hex title / application id (case-insensitive; client normalizes lower)                                             |
| `REGION`        | **Uppercase** ISO 3166-1 alpha-2 (`JP`, `US`, `HK`, …). Lowercase often returns **200 HTML** without product redirect |
| `acdIndex`      | Optional, **0-based**. Selects the N-th store SKU for the same appId. Out-of-range → **falls back to 0**              |

### Client helpers

```ts
import { buildAppIdUrl, NsuidMapper } from 'nintendo-store-nsuid-mapper';

buildAppIdUrl('0100453019aa8000', 'JP');
// https://ec.nintendo.com/apps/0100453019aa8000/JP

buildAppIdUrl('0100453019aa8000', 'JP', { acdIndex: 1 });
// https://ec.nintendo.com/apps/0100453019aa8000/JP?acdIndex=1
```

---

## 3. Response shapes (Location)

Follow **only the first hop** (`redirect: "manual"`). Do not chase JP store queue / marketing redirects.

### 3.1 Storefront relative (JP / HK / AU / NZ, …)

```http
HTTP/2 307
Location: /JP/ja/titles/70010000088831
```

Pattern:

```text
/{REGION}/{lang}/{kind}/{nsuid}
kind ∈ titles | aocs | bundles | demos
```

### 3.2 Americas (US / CA / …)

```http
HTTP/2 307
Location: https://www.nintendo.com/pos-redirect/70010000088832?l=en&c=US
```

### 3.3 Europe (GB / DE / FR / …)

```http
HTTP/2 307
Location: https://www.nintendo-europe.com/redirect/?nsuid=70010000088833&country=GB&language=en
```

### 3.4 Not found

```http
HTTP/2 404
```

No `Location` → client returns `null`.

### 3.5 Redirect without product id

Some regions may 307 to a **generic** store page (no nsuid). Client treats as `null`.

### 3.6 200 HTML without redirect

Some region codes (observed: lowercase region; also **TW** for sample title) return SPA HTML with no server `Location`. Client returns `null` (cannot resolve without browser JS).

---

## 4. acdIndex — multi-SKU (Switch 2 Edition era)

Same `appId` in one region can map to **multiple catalog products**.

Measured **2026-07** for `0100453019aa8000` / **JP**:

| acdIndex      | NSUID            | Notes                                                          |
| ------------- | ---------------- | -------------------------------------------------------------- |
| `0` (default) | `70010000088831` | XenobladeX Definitive Edition (**HAC**, 2025-03-20)            |
| `1`           | `70010000116668` | Same title **Nintendo Switch 2 Edition** (**BEE**, 2026-02-19) |
| `2` (OOB)     | `70010000088831` | Falls back to index **0**                                      |

`labelPlatform` (`HAC` / `BEE`) on Savanna product detail distinguishes the two SKUs after resolve.

### Client behaviour

| Method                                      | Role                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| `resolveAppIdToNsuid(appId, region)`        | Default SKU only (`acdIndex=0`)                          |
| `resolveAppId(appId, region, { acdIndex })` | One SKU + metadata                                       |
| `enumerateSkus(appId, region)`              | Loop `acdIndex` until redirect nsuid **repeats** index 0 |

Client-side safeguards:

- every storefront request defaults to a 10-second timeout;
- `acdIndex` must be a non-negative safe integer;
- enumeration is limited to `1..32` requests even if Nintendo never repeats index 0;
- `AppIdResolveResult.redirectUrl` is the absolute first-hop target, not
  necessarily the final slug page.

---

## 5. Cross-region sample (acdIndex=0)

`0100453019aa8000` (XenobladeX DE), 2026-07:

| Region | NSUID            | Location shape                          |
| ------ | ---------------- | --------------------------------------- |
| JP     | `70010000088831` | `/JP/ja/titles/…`                       |
| US     | `70010000088832` | `pos-redirect/…`                        |
| HK     | `70010000088835` | `/HK/zh/titles/…`                       |
| GB     | `70010000088833` | `nintendo-europe.com/redirect/?nsuid=…` |
| AU     | `70010000088833` | `/AU/en/titles/…`                       |
| DE     | `70010000088833` | Europe redirect                         |

Different regions → **different nsuids** for the same software title id. This is expected eShop catalog layout.

---

## 6. Resolving product identity

A typical pipeline is:

1. Obtain an application ID from a product's `applications.id`.
2. Use `resolveAppIdToNsuid(appId, "HK")` to discover a target catalog entry.
3. Use `mapNsuid` when the result must preserve the source edition. It also
   verifies platform, rights and bundle members rather than accepting a redirect
   alone.
4. Query the selected NSUID for any presentation fields the caller needs.

---

## 7. Which product kinds work? (7001 / 7003 / 7005 / 7009)

`/apps/{id}/{REGION}` is an **Application** entry. It resolves **base software application ids**
to **title catalog products** (typically `…/titles/7001…`). It is **not** a general
“any 16-hex → product nsuid” map for demos / DLC / consumables.

Measured 2026-07 (GBF Relink Endless family + samples):

| Source product | nsuid prefix | 16-hex available?                                                  | `/apps/{hex}` result                                               |
| -------------- | ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Title**      | `7001`       | Yes — Savanna `applications.id` / znej `titleIds`                  | ✅ **307** → `/…/titles/{7001…}` (or US/EU title redirect)         |
| **Demo**       | `7003`       | Yes — znej `titleIds` (Savanna public `demoItem` has **no** appId) | ⚠️ **307** but lands on **parent title 7001**, **not** demo `7003` |
| **DLC / AOC**  | `7005`       | Yes — Savanna `romRights.titleId` / znej `titleIds`                | ❌ **404** (content titleId ≠ Application id)                      |
| **Consumable** | `7009`       | ❌ none on public Savanna / znej product JSON                      | ❌ nothing to resolve                                              |

### Concrete samples

| Input 16-hex       | Kind of id                          | JP Location                                                       |
| ------------------ | ----------------------------------- | ----------------------------------------------------------------- |
| `0400f1c021178000` | Title application id                | `/JP/ja/titles/70010000112253` ✅                                 |
| `040027502647c000` | **Demo** titleId (`70030000024533`) | `/JP/ja/titles/70010000112253` ⚠️ same **parent title**, not demo |
| `0400f1c0211790cb` | **DLC** titleId (`70050000072807`)  | **404**                                                           |
| (none)             | Consumable `70090000019157`         | —                                                                 |

`acdIndex` multi-SKU (HAC / BEE) still only walks **title** SKUs (`7001`), not demo/DLC rows.

### Practical guidance

| Goal                               | Use                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| Title appId → regional title nsuid | **`nintendo-store-nsuid-mapper`** ✅                                                |
| Demo / DLC nsuid → detail          | Savanna `getDemo` / `getDlc` (you already have nsuid)                               |
| DLC 16-hex → parent 7001           | Clear the low 13 bits to derive the base AppID, then resolve that AppID via `/apps` |
| Demo 16-hex → demo 7003            | **Not** via `/apps` (redirects to parent title)                                     |
| Consumable reverse                 | **Not supported** (no public application id)                                        |

---

## 8. Limits & pitfalls

1. **Not a JSON API** — only redirects; do not expect product payload here.
2. **Region must be uppercase** for reliable 307 product Locations.
3. **Title Application ids only** — DLC content titleIds **404**; demo titleIds resolve to **parent title**, not `7003`.
4. **Multi-SKU** is the new normal after Switch 2 Edition dual listings; default is always index 0.
5. **KR / TW / odd codes** may not yield a product nsuid; treat as missing.
6. Do **not** follow the full redirect chain into regional store queue systems (JP store-jp, etc.).

---

## 9. Cross-region nsuid map (`mapNsuid`)

There is no official "same product, other country" API. This package builds the
hop from an identity query plus the redirector above.

| Kind                    | Anchor                                             | Target side                                                                     |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| title                   | application ID, platform, complete rights          | redirector plus verified base/upgrade SKUs                                      |
| dlc                     | platform and complete rights                       | all derived parents, DLC/upgrade candidates, unique complete match              |
| bundle                  | platform, complete rights, typed member signatures | all linked parents, unique complete bundle identity                             |
| demo                    | no application anchor                              | unsupported standalone mapping                                                  |
| consumable              | no application anchor                              | unsupported standalone mapping; itemId and publisher ID identify bundle members |
| catalog / normal ticket | recognized by common nsUid and type                | unsupported mapping; reported separately from a missing product                 |

Names and localized descriptions do not participate in matching. Bundle signatures
retain all member application IDs and rights, and duplicate members. Consumable
members use exact `itemId` plus `consumableItemGroup.publisher.id`; the region-local
group ID is excluded. A first ID or a plain application-ID set cannot distinguish
all editions. See [the technical design](technical-design.zh-CN.md) for current
query selections, limits and verified examples.

### 9.1 DLC content AppID → base Application ID

The public Savanna `dlcItem` node does not expose a selectable parent edge:
`targetApplicationItems`, `applications`, and similar reverse fields are
rejected with `INVALID_PARAM`. It does expose the DLC content Title ID:

```graphql
dlcItem(nsUid: $nsUid) {
  romRights {
    titleId
  }
}
```

Nintendo's AOC allocation reserves the low `0x1000..0x1fff` range above the
base application. Recover the parent Title AppID by clearing the low 13 bits:

```ts
import { deriveBaseApplicationIdFromDlcAppId } from '../src/index.ts';

const parentAppId = deriveBaseApplicationIdFromDlcAppId('0100616025b6d002');
// 0100616025b6c000
```

The underlying operation is:

```ts
const parentAppId = BigInt(`0x${dlcAppId}`) & ~0x1fffn;
```

Observed examples:

| Platform | DLC content AppID  | Derived parent AppID |
| -------- | ------------------ | -------------------- |
| HAC      | `0100616025b6d002` | `0100616025b6c000`   |
| HAC      | `01006f80023273e8` | `01006f8002326000`   |
| BEE      | `040074a01bf13001` | `040074a01bf12000`   |
| BEE      | `0400f1c021179160` | `0400f1c021178000`   |

Two live 40-row US batches (79 unique DLC NSUIDs) produced a DLC AppID for
every row. Every derived parent AppID resolved through
`/apps/{parentAppId}/US` and exactly matched the resulting parent Title's
Savanna `applications.id`.

Important distinction:

- Parent identity derivation is deterministic and does not require
  `parentNsuid`.
- Target DLC discovery uses paginated `dlcItems` plus the parent's
  `upgradeInfo.upgradeDlcItem`. Parent discovery considers every right, not just
  the representative AppID returned by an ID-only lookup.
- A scan that reaches its cap or an empty page before the declared total remains
  incomplete; it cannot establish a unique match.
- Missing or ambiguous membership returns an unmapped target with a `reason`,
  without inferring an NSUID from names.

The mapper sends its minimal Savanna queries directly and does not import a
sibling client. Standalone Demo and Consumable mapping is unsupported; no
`parentNsuid` option or name-based fallback is implemented.

---

## 10. Package layout

```text
src/
  client.ts       NsuidMapper public facade and transport wiring
  mapping.ts      cross-region matching decisions
  upstreams/
    savanna.ts    GraphQL documents, requests, paging and response parsing
    redirector.ts URL, HTTP, timeout, SKU and Location handling
  ids.ts          upstream-independent appId / nsuid validation
  catalogs.ts     supported countries and effective Savanna languages
  types.ts
  constants.ts
  errors.ts
  index.ts
docs/
  apps-redirector.md   ← this file
examples/basic.ts
tests/
```

## SKU-preserving mapping (2026-09-15)

`acdIndex` is a candidate index, not a platform code: Diablo IV's default is BEE,
while Paddle returns its HAC SKU even for index 1. Out-of-range indices may
repeat the default SKU. Keep `resolveAppIdToNsuid` at its documented default 0.

`mapNsuid` now checks the default target and its explicit `upgradeInfo` title
links against the source appId, platform and full title-right set. It returns
a reason instead of a different edition when no unique verified match exists.
For upgrade DLC it also checks `upgradeInfo.upgradeDlcItem`.
