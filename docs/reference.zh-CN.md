# 参考文档

[English](reference.md) · [README](../README.zh-CN.md) · [原理说明](how-it-works.zh-CN.md)

国家使用两位 ISO 代码（`JP`、`US`、`GB`），可使用小写。NSUID 可以是字符串或数字。

## mapNsuid

```ts
const result = await mapper.mapNsuid(nsuid, { from, to, ...requestOptions });
```

| 选项                     | 含义                                                  |
| ------------------------ | ----------------------------------------------------- |
| `from`                   | 源 NSUID 所属的国家。NSUID 只能在其所属的商店中查到。 |
| `to`                     | 最多 8 个目标国家，重复项会被去除。                   |
| `signal`、`timeoutMs` 等 | 见[请求选项](#请求选项)。                             |

返回结果：

```ts
{
  source: { region, nsuid, kind, code?, reason?, … }, // 在 from 中读取的源商品
  targets: [{ region, nsuid?, code?, reason? }],       // 每个目标国家一项，顺序与 to 相同
}
```

- 找到商品时有 `nsuid`，否则有 `code` 和 `reason`。程序应根据 `code` 判断（见[结果代码](#结果代码)）；`reason` 的措辞可能调整。
- `source.kind`：`title`、`dlc`、`bundle`、`demo`、`consumable` 或 `unknown`。
- 源商品无法映射时，`source` 带有相同的 `code` 和 `reason`，且不会请求任何目标国家。
- `source` 的其他字段是用于比较的身份数据：application ID、platform、ROM rights 和 bundle 成员。

## 结果代码

| `code`                  | 含义                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `source_not_found`      | 源国家没有返回该 NSUID，它可能属于其他国家。                            |
| `unsupported`           | 不支持的类型：consumable、ticket、未知类型，或含有不支持成员的 bundle。 |
| `insufficient_identity` | Savanna 缺少比较所需的数据，例如 platform 或 ROM rights。               |
| `unresolved`            | Redirector 在目标国家没有返回该 application ID 对应的商品。             |
| `no_candidates`         | 目标国家没有返回任何候选。                                              |
| `no_match`              | 返回了候选，但没有身份相同的。                                          |
| `ambiguous`             | 有多个候选身份相同。                                                    |
| `incomplete`            | 查找在完成前达到上限。                                                  |

任何 `code` 都不能证明商品在目标国家没有销售。列表中不包含已下架的商品，所以已下架的商品会表现为 `no_candidates` 或 `no_match`；在目标地区使用不同 application ID 的 title 会表现为 `unresolved`。

## 其他方法

| 方法                                         | 返回                                                       |
| -------------------------------------------- | ---------------------------------------------------------- |
| `resolveNsuidToAppId(nsuid, country)`        | Application ID，或 `null`（bundle、demo、consumable 没有） |
| `resolveNsuidsToAppIds(nsuids, country)`     | NSUID 到 application ID 或 `null` 的 `Map`，只发一次请求   |
| `resolveAppIdToNsuid(appId, country)`        | Redirector 返回的 NSUID，或 `null`                         |
| `resolveAppId(appId, country, { acdIndex })` | 同上，另含重定向 URL 和路径类型                            |
| `enumerateSkus(appId, country, { max })`     | Redirector 对该 application ID 返回的全部商品              |
| `buildUrl(appId, country, acdIndex?)`        | Redirector URL，不发请求                                   |

- 这些是查询，不是映射。DLC 返回的是其第一个 ROM right，redirector 每次只返回一个商品。需要区分版本时请用 `mapNsuid`。
- `resolveNsuidsToAppIds` 要求所有 NSUID 来自同一个商店。本项目不限制批量大小，但 Savanna 的上限未知，建议每批约 100 个。
- `acdIndex` 用于在同一 application ID 的多个商品中选择，从 0 开始。它是序号，不对应 platform。`enumerateSkus` 依次尝试 0、1、2……直到商品重复；`max` 默认 16，最大 32。
- 在客户端上设置 `defaultRegion` 后，可以省略国家参数。

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

| 选项                  | 含义                                              |
| --------------------- | ------------------------------------------------- |
| `timeoutMs`           | 默认的单次请求超时，见[请求选项](#请求选项)       |
| `retries`             | 默认重试次数                                      |
| `headers`             | 两个接口的额外请求头，覆盖同名的默认值            |
| `fetch`               | 自定义的 `fetch` 实现，例如用于测试               |
| `defaultRegion`       | 查询方法省略国家时使用的国家                      |
| `defaultEnumerateMax` | `enumerateSkus` 的默认 `max`                      |
| `baseUrl`             | Redirector 的主机，默认 `https://ec.nintendo.com` |

## 请求选项

所有方法的最后一个参数都接受以下选项，并覆盖客户端选项。

| 选项        | 含义                                                               |
| ----------- | ------------------------------------------------------------------ |
| `timeoutMs` | 单次请求的超时，包含其重试。1 到 120000 的整数，默认 10000。       |
| `retries`   | 暂时性失败后的重试次数。默认 2，最大 5；`0` 表示不重试。           |
| `signal`    | 用于整次调用的 `AbortSignal`，例如 `AbortSignal.timeout(30_000)`。 |
| `headers`   | 额外请求头                                                         |
| `fetch`     | 自定义的 `fetch` 实现                                              |

`timeoutMs` 作用于每个请求，而一次映射会发出多个请求。需要限制整次调用时请使用 `signal`。

网络错误、HTTP 429 和 HTTP 5xx 会以指数退避加随机抖动的方式重试。`Retry-After` 响应头指定最短等待时间；如果该等待超过剩余超时，立即抛出原始错误。其他错误不重试。

无效输入（NSUID 或国家代码格式错误、目标国家超过 8 个、`timeoutMs` 无效）会在发出请求前抛出 `TypeError`。

## 错误

请求在重试后仍失败时抛出 `NsuidMapError`：

| 字段           | 含义                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `kind`         | `network`、`timeout`、`abort`、`http`、`graphql`、`response` 或 `other` |
| `status`       | 收到响应时的 HTTP 状态码                                                |
| `url`          | 请求的 URL                                                              |
| `retryable`    | 为 `true` 时，稍后重试可能成功                                          |
| `retryAfterMs` | `Retry-After` 要求的等待时间，单位毫秒                                  |

`abort` 表示调用被 `signal` 取消；`response` 表示响应无法解析。任一目标国家失败时，整个 `mapNsuid` 调用都会抛出错误。如需保留其他国家的结果，请使用[底层函数](#底层函数)逐个国家映射。

## 请求次数

`mapNsuid` 先为源商品发送一次 Savanna 请求，之后每个目标国家：

| 类型        | 每个目标国家的请求数                                                           |
| ----------- | ------------------------------------------------------------------------------ |
| Title、demo | 1 次 redirector + 1 次 Savanna                                                 |
| DLC         | 每个所属 title 1 次 redirector + 每 100 个 DLC 1 次 Savanna                    |
| Bundle      | 每个所属 title 1 次 redirector + 每个 title 及其关联版本每 100 条 1 次 Savanna |

大多数商品只有一个所属 title，所以大多数映射每个国家需要 2 次请求。目标国家之间并发，同一国家内的请求依次发送。每次查找最多读取 16 个所属 title，每个 title 最多 40 页。

## 国家列表

基于 2026-07-23 的一次测试：使用四款广泛发售的 title，测试了 Savanna 支持的全部 92 个国家。任天堂可能随时调整。国家受支持不代表每个商品都在该国销售。

### 支持（45 个）

| 地区            | 国家                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 亚洲（2）       | 日本 `JP`、香港 `HK`                                                                                                                                                                                                                                                                                                                                                                                        |
| 美洲（8）       | 美国 `US`、加拿大 `CA`、墨西哥 `MX`、巴西 `BR`、阿根廷 `AR`、智利 `CL`、哥伦比亚 `CO`、秘鲁 `PE`                                                                                                                                                                                                                                                                                                            |
| 欧洲（31）      | 英国 `GB`、爱尔兰 `IE`、德国 `DE`、奥地利 `AT`、瑞士 `CH`、法国 `FR`、比利时 `BE`、卢森堡 `LU`、荷兰 `NL`、意大利 `IT`、西班牙 `ES`、葡萄牙 `PT`、丹麦 `DK`、瑞典 `SE`、挪威 `NO`、芬兰 `FI`、波兰 `PL`、捷克 `CZ`、斯洛伐克 `SK`、匈牙利 `HU`、罗马尼亚 `RO`、保加利亚 `BG`、克罗地亚 `HR`、斯洛文尼亚 `SI`、希腊 `GR`、塞浦路斯 `CY`、马耳他 `MT`、爱沙尼亚 `EE`、拉脱维亚 `LV`、立陶宛 `LT`、俄罗斯 `RU` |
| 大洋洲（2）     | 澳大利亚 `AU`、新西兰 `NZ`                                                                                                                                                                                                                                                                                                                                                                                  |
| 非洲和中东（2） | 南非 `ZA`、以色列 `IL`                                                                                                                                                                                                                                                                                                                                                                                      |

### 不支持（47 个）

在这些国家，redirector 返回通用商店页面、空白页面或 404。

| 地区             | 国家                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 东亚（3）        | 韩国 `KR`、台湾 `TW`、中国大陆 `CN`                                                                                                                                                                                                                                                                                                                                                      |
| 东南亚（4）      | 马来西亚 `MY`、菲律宾 `PH`、新加坡 `SG`、泰国 `TH`                                                                                                                                                                                                                                                                                                                                       |
| 中东（3）        | 阿联酋 `AE`、沙特阿拉伯 `SA`、土耳其 `TR`                                                                                                                                                                                                                                                                                                                                                |
| 中南美洲（15）   | 玻利维亚 `BO`、伯利兹 `BZ`、哥斯达黎加 `CR`、厄瓜多尔 `EC`、法属圭亚那 `GF`、危地马拉 `GT`、圭亚那 `GY`、洪都拉斯 `HN`、尼加拉瓜 `NI`、巴拿马 `PA`、巴拉圭 `PY`、苏里南 `SR`、萨尔瓦多 `SV`、乌拉圭 `UY`、委内瑞拉 `VE`                                                                                                                                                                  |
| 加勒比地区（22） | 安提瓜和巴布达 `AG`、安圭拉 `AI`、阿鲁巴 `AW`、巴巴多斯 `BB`、百慕大 `BM`、巴哈马 `BS`、多米尼克 `DM`、多米尼加共和国 `DO`、格林纳达 `GD`、瓜德罗普 `GP`、海地 `HT`、牙买加 `JM`、圣基茨和尼维斯 `KN`、开曼群岛 `KY`、圣卢西亚 `LC`、马提尼克 `MQ`、蒙特塞拉特 `MS`、特克斯和凯科斯群岛 `TC`、特立尼达和多巴哥 `TT`、圣文森特和格林纳丁斯 `VC`、英属维尔京群岛 `VG`、美属维尔京群岛 `VI` |

不在以上两个列表中的国家仍会发出请求。

## 国家与语言

| 函数                                        | 返回                                                      |
| ------------------------------------------- | --------------------------------------------------------- |
| `isMappable(country)`                       | 不支持的国家返回 `false`，其他返回 `true`，包括未知代码   |
| `contextFor(country)`                       | `{ country, language }`：规范化的国家代码及查询使用的语言 |
| `getCountryLanguageInfo(country)`           | 默认语言和可用语言，或 `undefined`                        |
| `isCountryLanguageSupported(country, lang)` | 该语言是否在该国的语言列表中                              |

同一地区的国家常共用 NSUID（例如 GB 和 AU），但并非总是如此，请分别查询需要的每个国家。

## 底层函数

| 导出                                                 | 用途                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| `fetchIdentities`、`mapInto`                         | 只读取一次源商品，再逐个国家映射并分别处理失败    |
| `execute`、`SHOP_ID`、`contextFor`                   | 发送自定义 Savanna 查询，例如映射后读取名称或价格 |
| `isAppId`、`parseAppId`、`isCatalogId`、`parseNsuid` | 校验并规范化编号                                  |
| `itemKindFromNsuid`                                  | 根据 NSUID 前缀判断商品类型                       |
| `deriveBaseApplicationIdFromDlcAppId`                | DLC ID 所属 title 的 application ID               |
| `buildAppIdUrl`                                      | 不创建客户端，直接生成 redirector URL             |
| `MAX_REGIONS_PER_MAP`                                | 目标国家上限（8）                                 |

`fetchIdentities` 和 `mapInto` 不做客户端的输入校验，也不限制国家数量。

```ts
import { contextFor, fetchIdentities, mapInto, NsuidMapper } from 'nsuid-mapper';

const mapper = new NsuidMapper();
const { country, language } = contextFor('JP');
const source = (await fetchIdentities([nsuid], country, language)).get(nsuid)!;
const results = await Promise.allSettled(
  ['US', 'GB', 'HK'].map((target) => mapInto(source, target, mapper)),
);
```

[examples/basic.ts](../examples/basic.ts) 包含完整的自定义查询示例。查询中只要有一个未知字段，Savanna 就会拒绝整个查询。
