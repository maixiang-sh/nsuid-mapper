# 参考文档

[English](reference.md) · [README](../README.zh-CN.md) · [原理说明](how-it-works.zh-CN.md)

国家用两位字母代码表示，例如 `JP`、`US`、`GB`，小写也可以。NSUID 可以是字符串，也可以是数字。

## mapNsuid

```ts
const result = await mapper.mapNsuid(nsuid, { from, to, ...requestOptions });
```

| 选项                     | 含义                                             |
| ------------------------ | ------------------------------------------------ |
| `from`                   | NSUID 所属的国家。NSUID 只能在它所属的国家查到。 |
| `to`                     | 最多 8 个目标国家，重复的国家只算一次。          |
| `signal`、`timeoutMs` 等 | [请求选项](#请求选项)                            |

返回结果：

```ts
{
  source: { region, nsuid, kind, code?, reason?, … }, // 在 from 国家读到的源商品
  targets: [{ region, nsuid?, code?, reason? }],       // 每个目标国家一项，顺序与 to 相同
}
```

- 找到商品时，`targets[i].nsuid` 有值。
- 否则 `code` 给出[分类](#结果代码)，`reason` 是给人看的一句话说明。程序里请判断 `code`；`reason` 的措辞可能调整。
- `source.kind` 是 `title`（本体）、`dlc`、`bundle`（合集）、`demo`（体验版）、`consumable`（消耗品）或 `unknown`。如果源商品本身无法映射，`source` 上会带同样的 `code` 和 `reason`，并且不会请求任何目标国家。
- `source` 的其他字段（游戏编号、平台、内容权益、合集成员）是用于比较的数据。

## 结果代码

| 代码                    | 含义                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `source_not_found`      | 源国家没有返回这个 NSUID，它可能属于别的国家。                             |
| `unsupported`           | 这种商品类型无法映射：消耗品、兑换券、未知类型，或含有无法比较成员的合集。 |
| `insufficient_identity` | 任天堂的数据缺少比较所需的信息，例如平台或内容权益。                       |
| `unresolved`            | 跳转链接在目标国家找不到这个游戏编号对应的商品。                           |
| `no_candidates`         | 目标国家没有列出任何可以比较的商品。                                       |
| `no_match`              | 找到了商品，但没有一个是同一个商品。                                       |
| `ambiguous`             | 不止一个商品匹配，而数据无法区分它们。                                     |
| `incomplete`            | 查找在上限处中断，无法确认结果。                                           |

这些代码都不能证明目标国家没有卖这个商品。尤其是：商品列表不包含已下架的商品，所以已下架的商品会表现为 `no_candidates` 或 `no_match`；在不同地区使用不同游戏编号的游戏会表现为 `unresolved`。

## 其他方法

| 方法                                         | 返回                                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| `resolveNsuidToAppId(nsuid, country)`        | 游戏编号，或 `null`。合集、体验版和消耗品没有游戏编号。     |
| `resolveNsuidsToAppIds(nsuids, country)`     | 一个 `Map`，键是 NSUID，值是游戏编号或 `null`；只发一次请求 |
| `resolveAppIdToNsuid(appId, country)`        | 跳转链接指向的 NSUID，或 `null`                             |
| `resolveAppId(appId, country, { acdIndex })` | 同上，另外包含跳转地址和路径类型                            |
| `enumerateSkus(appId, country, { max })`     | 这个游戏编号通过跳转链接能到达的全部商品                    |
| `buildUrl(appId, country, acdIndex?)`        | 跳转链接本身，不发请求                                      |

说明：

- 这些是查询，不是映射。DLC 返回的游戏编号是它的某一个内容编号；一个游戏编号对应多个商品时，跳转链接也只返回其中一个。需要确定具体版本时，请用 `mapNsuid`。
- 传给 `resolveNsuidsToAppIds` 的 NSUID 必须来自同一个国家的商店。本项目不限制数量，但任天堂的上限未知；数量多时请按每批约 100 个分批发送。
- `acdIndex` 用于在一个游戏编号对应的多个商品中选择，从 0 开始。它是序号，不代表平台。`enumerateSkus` 依次尝试 0、1、2……直到商品重复为止；`max` 默认 16，最大 32。
- 在客户端上设置 `defaultRegion` 后，查询方法可以省略国家参数。

## 客户端选项

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

| 选项                  | 含义                                                   |
| --------------------- | ------------------------------------------------------ |
| `timeoutMs`           | 每次请求的默认时间上限，见[请求选项](#请求选项)        |
| `retries`             | 默认重试次数                                           |
| `headers`             | 发给两个任天堂服务的额外请求头，会覆盖同名的默认请求头 |
| `fetch`               | 替换用的 `fetch` 函数，例如在测试中使用                |
| `defaultRegion`       | 查询方法未传国家时使用的国家                           |
| `defaultEnumerateMax` | `enumerateSkus` 的默认 `max`                           |
| `baseUrl`             | 跳转链接的主机，默认 `https://ec.nintendo.com`         |

## 请求选项

每个方法的最后一个参数都接受这些选项，会覆盖客户端选项。

| 选项        | 含义                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| `timeoutMs` | 单次请求任天堂的时间上限，包括它的重试。1 到 120000 之间的整数毫秒，默认 10000。 |
| `retries`   | 遇到可能是暂时性的失败后额外重试的次数。默认 2，最多 5；设为 `0` 关闭重试。      |
| `signal`    | 用于取消整次调用的 `AbortSignal`，例如 `AbortSignal.timeout(30_000)`。           |
| `headers`   | 额外的请求头                                                                     |
| `fetch`     | 替换用的 `fetch` 函数                                                            |

一次映射会发出多个请求，`timeoutMs` 分别作用于每一个请求。要限制整次调用的时间，请用 `signal`。

**哪些情况会重试**：网络错误、HTTP 429（请求过多）和 HTTP 5xx（服务器错误）。每次重试前的等待时间逐次变长，并带一点随机性。如果任天堂返回了 `Retry-After` 请求头，至少等待它要求的时间；如果剩余时间不够等，就立即停止并抛出原来的错误。其他错误不重试。

无效的输入，例如格式错误的 NSUID、格式不对的国家代码、超过 8 个目标国家或无效的 `timeoutMs`，会在发出任何请求之前抛出 `TypeError`。

## 错误

重试用完仍然失败的请求会抛出 `NsuidMapError`：

| 字段           | 含义                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `kind`         | `network`、`timeout`、`abort`（被取消）、`http`、`graphql`、`response`（无法读取的响应）或 `other` |
| `status`       | 有响应时的 HTTP 状态码                                                                             |
| `url`          | 请求的地址                                                                                         |
| `retryable`    | 为 `true` 时，稍后再试可能会成功                                                                   |
| `retryAfterMs` | 任天堂通过 `Retry-After` 要求等待的时间，单位毫秒                                                  |

只要有一个目标国家这样失败，整个 `mapNsuid` 调用就会抛出错误。如果想保留其他国家的结果，请用[底层函数](#底层函数)逐个国家映射。

## 请求次数

`mapNsuid` 先为源商品发一次 Savanna 请求，然后每个目标国家：

| 商品类型     | 每个目标国家的请求数                                           |
| ------------ | -------------------------------------------------------------- |
| 本体、体验版 | 1 次跳转 + 1 次 Savanna                                        |
| DLC          | 每款游戏 1 次跳转 + 每 100 个 DLC 1 次 Savanna                 |
| 合集         | 每款游戏 1 次跳转 + 每款游戏及其关联版本每 100 条 1 次 Savanna |

大多数商品只属于一款游戏，所以大多数映射每个国家只需 2 次请求。各目标国家同时进行；同一个国家内的请求依次进行。每次查找最多读取 16 款游戏，每款游戏最多 40 页。

## 国家与语言

| 函数                                        | 返回                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `isMappable(country)`                       | 已知不可用的国家（如 `KR`、`TW`）返回 `false`，其他返回 `true`，包括未知代码 |
| `contextFor(country)`                       | `{ country, language }`：规范化后的国家代码，以及查询该国时使用的语言        |
| `getCountryLanguageInfo(country)`           | 该国的默认语言和可用语言，或 `undefined`                                     |
| `isCountryLanguageSupported(country, lang)` | 该语言是否在该国的语言列表里                                                 |

同一地区的国家常常共用 NSUID，例如英国和澳大利亚。这很常见但不保证，所以请始终查询你需要的每一个国家。

## 底层函数

| 导出                                                 | 用途                                                   |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `fetchIdentities`、`mapInto`                         | 只读一次源商品，再逐个国家映射，分别处理每个国家的失败 |
| `execute`、`SHOP_ID`、`contextFor`                   | 发送自己编写的 Savanna 查询，例如映射后读取名称或价格  |
| `isAppId`、`parseAppId`、`isCatalogId`、`parseNsuid` | 检查并规范化编号                                       |
| `itemKindFromNsuid`                                  | 根据 NSUID 前四位判断商品类型                          |
| `deriveBaseApplicationIdFromDlcAppId`                | DLC 内容编号所属的游戏编号                             |
| `buildAppIdUrl`                                      | 不创建客户端，直接生成跳转链接                         |
| `MAX_REGIONS_PER_MAP`                                | 目标国家上限 8                                         |

`fetchIdentities` 和 `mapInto` 不做客户端的输入检查，也不限制国家数量。

```ts
import { contextFor, fetchIdentities, mapInto, NsuidMapper } from 'nsuid-mapper';

const mapper = new NsuidMapper();
const { country, language } = contextFor('JP');
const source = (await fetchIdentities([nsuid], country, language)).get(nsuid)!;
const results = await Promise.allSettled(
  ['US', 'GB', 'HK'].map((target) => mapInto(source, target, mapper)),
);
```

完整的自定义查询示例见 [examples/basic.ts](../examples/basic.ts)。查询里只要有一个 Savanna 不认识的字段，整个查询就会失败。
