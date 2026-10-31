# Mapping outcomes and failure reasons

[中文](mapping-outcomes.zh-CN.md) · [README](../README.md) · [Reference](reference.md) · [How it works](how-it-works.md)

This page classifies known unmapped results, ambiguity and execution errors.
A result code describes where mapping stopped; a cause explains why it stopped
there. They are not one-to-one: `no_match` can mean different identities or that
the matching product never entered the candidate list.

The list includes verified product observations and boundaries covered by the
implementation and tests. Not every boundary has occurred in production.
Product examples were checked on **2026-10-31**; availability and upstream
responses may change.

## Mapping outcomes

Each target has a [`status`](reference.md#result-status); an unmapped target also
has `code` and `reason`. This section explains each `code`. The explanatory
wording in `reason` may change.

| `code`                  | Category                          | Known causes or conditions                                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_not_found`      | Source not returned               | The source NSUID belongs to another catalog, the product is no longer readable, or upstream omitted the entry. This does not prove the product does not exist.                                                                                                                         |
| `unsupported`           | Unsupported type                  | Standalone consumables, catalog vouchers, subscription products themselves, unknown types, or bundles containing members without supported cross-region identity. Limited ordinary time-ticket support does not include subscription products themselves or ticket members of bundles. |
| `insufficient_identity` | Missing or contradictory identity | Missing application ID, platform, ROM rights or complete members; no valid parent anchor; incomplete demo relations; missing or conflicting time-ticket identity. See the detail below.                                                                                                |
| `unresolved`            | Cross-region entry unresolved     | The redirector returns no product for the source application ID in the target country. Regional builds may use different application IDs. DLC and bundles can also stop here when their parent titles cannot be resolved.                                                              |
| `no_candidates`         | No target candidates discovered   | A parent resolves but its listings contain no product of the required kind; a product is delisted or hidden from listings; a target title has no same-platform demo; a target ticket group is absent or lists no ordinary tickets.                                                     |
| `no_match`              | Candidates found, none matched    | Different platforms, complete ROM rights, bundle members or multiplicities, consumable member keys, or time-ticket group, publisher, exact minutes or subscription relation. The matching product may also be missing from the returned list.                                          |
| `ambiguous`             | No unique product                 | Several target products match, or the source identity, parent title or relationship chain is ambiguous. See [ambiguity causes](#ambiguity-causes).                                                                                                                                     |
| `incomplete`            | Candidate scan unfinished         | A parent or paging cap was reached, or upstream declared more results but returned an early empty page. DLC/bundle scans read at most 16 parent titles and 40 pages of 100 entries per title. An unfinished scan cannot establish uniqueness.                                          |

None of these results alone proves that a product is not sold in the target
country. Delisting, catalog differences, discovery limits and identity
differences can produce the same result.

### Business causes

About 78,000 unmapped results between the JP, US, GB and HK stores, recorded on
**2026-10-31**, were classified by comparing ROM rights, names, publishers and
sales status in stored catalogs:

| Cause                                     | Share | Usual `code`                                           | Observations                                                                                                                                                                             |
| ----------------------------------------- | ----- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Not released in the target store          | 68%   | `unresolved`                                           | Western independent titles absent from HK and JP; Japanese titles sold only in JP. DLC and bundles follow their title.                                                                   |
| Sold there as a different product         | 20%   | `unresolved`                                           | A separate release with other application IDs, often from a local publisher, e.g. eastasiasoft in Asia or XSEED in the US. A lower bound: names in different languages are not compared. |
| Title sold there, this DLC or bundle not  | 4%    | `no_candidates`, `no_match`                            | Regional DLC, regional bundles or bundles with other contents. `titles` lists the target title.                                                                                          |
| Delisted                                  | 5%    | `unresolved`, `no_candidates`, `insufficient_identity` | The target store no longer lists the product.                                                                                                                                            |
| New or pre-order product, data incomplete | 0.8%  | `insufficient_identity`                                | Missing application ID or ROM rights; usually filled in after release.                                                                                                                   |
| Several listings of one product           | 0.6%  | `ambiguous`                                            | See [ambiguity causes](#ambiguity-causes).                                                                                                                                               |
| Search limits                             | 0.6%  | `incomplete`, `source_not_found`                       | Mostly large multi-game collections.                                                                                                                                                     |

The shares describe that set as a whole. A single result's cause cannot be read
from its `code`.

### Insufficient identity in detail

| Type                 | Conditions                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title / DLC          | Missing application ID, platform or complete ROM rights; a malformed DLC content ID or one outside the valid ranges for deriving a parent.                                                                                                                                                                                                     |
| Bundle               | Missing platform, ROM rights, members or a valid parent anchor; a title/DLC member missing platform, application ID or rights; a consumable member missing a valid `itemId` or publisher ID.                                                                                                                                                   |
| Demo                 | Missing platform or parent title; the source title lists no same-platform demo, or lists other demos without the source demo. A one-way relation is insufficient.                                                                                                                                                                              |
| Ordinary time ticket | Missing valid group ID, publisher, exact positive integer minutes or explicit subscription relation; a declared group ID that differs from the nested group; the source identity absent from its group; incomplete ordinary-ticket identities or conflicting identities for the same NSUID. An absent subscription field is not explicit null. |

The location of missing data affects the code. An incomplete target title, DLC
or bundle candidate may fail comparison and contribute to `no_match`; the code
alone cannot distinguish missing fields from a different product. Ordinary
time-ticket mapping explicitly rejects incomplete candidate groups.

## Ambiguity causes

An NSUID identifies a sale listing. Application IDs, ROM rights and bundle
members mainly describe software entitlements. Multiple sale listings can have
the same entitlements. `ambiguous` means the available evidence cannot select
one NSUID; multiple valid counterparts can be a legitimate result.

| Cause                                                        | Known observations and examples                                                                                                                                                                                                                         | Interpretation                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple listings of the same product                        | Older and reissued listings coexist, sometimes with different publishers. AVICII Invector: Encore Edition JP `70070000021578` has HK candidates `70070000011231` and `70070000021580`, with identical public content identity and different publishers. | Preserve every matching candidate. A publisher change alone does not invalidate a same-product relationship and does not automatically exclude either listing. |
| Different commercial editions with identical public identity | Let's Sing 2024 standard, Gold and Platinum listings expose the same rights and members; Dreamlight standard and Magical DLC share an entitlement ID.                                                                                                   | Retain ambiguity. Distinguishing commercial editions needs more evidence than names, release dates or sales status.                                            |
| An entitlement reused by multiple listings                   | Several DLC chapters or waves share complete rights; multiple ordinary tickets in a group have the same minutes and subscription relation.                                                                                                              | Equal entitlements do not establish a one-to-one listing match. Ordinary time tickets require uniqueness in both source and target groups.                     |
| An ambiguous relationship chain                              | A source/target title lists multiple same-platform demos; a demo's parent title is ambiguous; different parents lead to different demos; source ticket identities repeat within their group.                                                            | Explain where ambiguity occurs. Do not put source-region or parent-title IDs into target-product candidates.                                                   |

These are explanatory categories, not new API codes or mutually exclusive
statistical buckets. A set of listings may involve both reissue and edition
differences. `ambiguous` alone cannot assign a category.

Current title/DLC/bundle matching does not exclude whole-product candidates by
their publisher. A consumable bundle member's publisher ID scopes its `itemId`,
and limited ordinary time-ticket support also requires the same group publisher.
Those identity checks are distinct from publisher differences between reissued
listings.

### Candidate fields

- When multiple target products of the source's kind match, return `ambiguous`
  with sorted, deduplicated `candidates` and no unique `nsuid`.
- Duplicate source time-ticket identities stop mapping before target requests.
  The source and targets carry `ambiguous`, without target `candidates`.
- When the source title has several demos, or a demo's parent title is ambiguous,
  those source-demo/parent-title IDs are not target-demo `candidates`; `reason`
  explains the conflict and `scope` is `source` when the conflict is in the
  source region. Target titles a demo's parent maps to are in `titles`.
- Candidates that failed matching are not returned: they are known to be
  different products. When a DLC, bundle or demo is not found but its target
  title is, `titles` lists that title.

### Verified examples

| Source and target                                        | Observation                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let's Sing 2024, GB `70070000018040` → HK                | Six candidates have the same public content fingerprint. Publisher separates them into two groups, each still containing standard, Gold and Platinum listings. Standalone time-ticket support cannot supply the missing bundle-to-specific-VIP-ticket relation. |
| Dreamlight: The Storybook Vale, GB `70050000052283` → JP | Standard `70050000052289` and Magical Edition `70050000052286` share `0100d39012c1b003` and remain two candidates.                                                                                                                                              |
| Let's Sing VIP, HK `70080000002057`                      | The source group contains three ordinary 43200-minute tickets with no subscription relation. Mapping remains ambiguous before any target request.                                                                                                               |

Positive bundle membership can provide Dreamlight review leads, but the source
and target bundles' commercial editions must first be verified independently.
Mapping bundles through the same conflicting rights and then using those
bundles to prove the DLC match would be circular. A DLC's reverse bundle list
can omit entries, so an empty list cannot exclude a candidate. These leads are
not part of automatic mapping rules.

## Input and execution errors

These throw exceptions and should be recorded separately from returned mapping
outcomes.

| Exception                      | Category                       | Typical causes                                                                                                                                                                               |
| ------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TypeError`                    | Invalid input or configuration | Malformed NSUID, application ID or country code; empty targets or more than 8; invalid timeout, retry or SKU enumeration parameters. Validation depends on the method called.                |
| `NsuidMapError.kind = network` | Network failure                | Connection, TLS or response-body read failures.                                                                                                                                              |
| `timeout`                      | Request timeout                | One request and its retries exhausted their time budget.                                                                                                                                     |
| `abort`                        | Caller cancellation            | The caller cancelled, or the whole-call `signal` reached its deadline.                                                                                                                       |
| `http`                         | HTTP error                     | Rate limiting, server failure or another status treated as an error by the adapter. Redirector 200/404 responses mean unresolved, rather than throwing HTTP errors.                          |
| `graphql`                      | GraphQL error                  | Permission rejection, unacceptable fields or arguments, authentication configuration, or another upstream GraphQL error. HTTP 200 can carry these errors; partial `data` does not hide them. |
| `response`                     | Invalid response format        | Non-JSON response, invalid GraphQL envelope, or missing/invalid `data`.                                                                                                                      |
| `other`                        | Other protocol error           | For example, a redirect status without `Location`.                                                                                                                                           |

Network failures and HTTP 429/5xx retry within the configured attempt count and
single-request time budget, respecting `Retry-After`. Permission and query-field
errors usually require a permission, configuration or query change. `timeout`
and `abort` end the current request without restarting its budget through an
internal retry.

An execution error is never converted to a mapping `code`. By default it rejects
the whole `mapNsuid` call; with `targetErrors: 'return'` the failed target has
`status: 'error'` and the others keep their results (see
[errors](reference.md#errors)).

## Catalog and snapshot quality

- Missing catalog names or `?` are metadata gaps. The mapper never compares
  names, so a missing name does not itself trigger `ambiguous` or exclude a candidate.
- Localization, punctuation and edition names alone do not prove identity or difference.
- An unrefreshed export records an earlier check, not the current Nintendo
  catalog or current production mapping state.
- A bundle snapshot selecting only `PUBLIC` can omit `UNSEARCHABLE` members and
  cannot prove complete content equality. The mapper currently selects both
  statuses when comparing members.

Retain the original code, reason, candidates and check time when recording a
review, then add independently confirmed causes and evidence. Leave unconfirmed
causes unknown. Do not turn missing names, delisting or one result code into a
claim that the target store does not sell the product.

## Implementation and validation

- [Mapping branches](../src/mapping.ts): candidate matching, demo relations,
  time tickets and search caps.
- [Savanna adapter](../src/upstreams/savanna.ts): identity reads, field
  completeness, pagination and GraphQL errors.
- [Redirector adapter](../src/upstreams/redirector.ts), [request retries](../src/request.ts)
  and [error types](../src/errors.ts): protocol and execution errors.
- [Demo tests](../tests/demo.test.ts), [bundle tests](../tests/bundles.test.ts),
  [DLC tests](../tests/dlc.test.ts), [time-ticket tests](../tests/tickets.test.ts)
  and [live regressions](../tests/live.regressions.test.ts): covered samples and boundaries.
