# nsuid-mapper

把 Nintendo eShop 商品的 NSUID 映射为其他国家对应商品的 NSUID。

[English](README.md) · [技术设计](docs/technical-design.zh-CN.md) · [Redirector 行为](docs/apps-redirector.md)

这是独立的 Bun + TypeScript 项目，没有运行时第三方依赖。本项目是非官方工具，与任天堂没有关联，也未获其认可。不需要发布到 npm；克隆后即可开发、运行示例和构建。

开发工具固定 Bun `1.4.3`、TypeScript `7.0.2`，为 2026-10-11 核实的最新正式版，不使用 canary / nightly。

## 能力与边界

| 类型        | 映射依据                                                     |
| ----------- | ------------------------------------------------------------ |
| 本体 `7001` | 应用编号、平台、全部 ROM 权益，并检查基础版 / 升级版候选     |
| DLC `7005`  | 平台与完整权益集合，从父商品的分页列表及升级信息寻找唯一匹配 |
| 合集 `7007` | 平台、完整权益及全部成员身份；保留重复成员的数量             |

合集内的消耗品使用 `itemId` 和发行商 ID 比较，不依赖名称、文案或跨区变化的分组 ID。

体验版 `7003` 没有自己的应用编号和权益，通过上游给出的所属本体映射：先按本体规则映射所属本体，再取目标本体名下的体验版；源本体和目标本体在该平台都必须恰好只有一个体验版，否则返回歧义。独立消耗品 `7009` 暂不映射；兑换券 `7002` 和课程券 `7008` 返回不支持的类型说明。上游未暴露的商品、身份信息不足、多个候选均匹配或分页未完成时，返回未映射原因，不猜测其他版本。

同款游戏可能使用不同的跨区 AppID，ROM 权益也不保证商品唯一。具体反例和已核实编号集中在[技术设计](docs/technical-design.zh-CN.md#验证样本)。Redirector 未解析到商品不能解释成“目标区没卖”。

## 本地使用

```bash
git clone https://github.com/maixiang-sh/nsuid-mapper.git
cd nsuid-mapper
bun install --frozen-lockfile
bun run build
```

在项目内可以直接引用源码：

```ts
import { NsuidMapper } from './src/index.ts';

const mapper = new NsuidMapper();
const result = await mapper.mapNsuid('70070000039081', {
  from: 'US',
  to: ['HK', 'JP', 'GB', 'AU'],
});

console.log(result.targets);
// 每个目标包含 region，以及映射后的 nsuid 或未映射 reason。
```

`mapNsuid` 每次处理一个商品，最多 8 个目标国家。同一国家内串行扫描父商品，不通过商品名匹配。

其他常用方法：

- `resolveAppIdToNsuid`：通过应用编号获取目标国家的默认商品编号；本身不保证版本一致。
- `resolveNsuidsToAppIds`：同区批量查询应用编号，返回一个代表编号，不等于完整商品身份。当前输入作为一次请求发送，客户端未设批量上限，不代表上游无限容量；大量编号建议每批约 100 条、串行调用。
- `enumerateSkus`：查看 Redirector 的候选商品。
- `contextFor`：获取国家对应的查询语言。

完整参数见[英文 README](README.md)，自定义 GraphQL 查询见[可运行示例](examples/basic.ts)。

## 公开接口

根入口的运行时导出从 37 项收敛为 18 项，不新增子入口：

- 常用入口：`NsuidMapper`、`NsuidMapError`、`MAX_REGIONS_PER_MAP`。
- ID / URL 工具：`isAppId`、`isCatalogId`、`parseAppId`、`parseNsuid`、`itemKindFromNsuid`、`deriveBaseApplicationIdFromDlcAppId`、`buildAppIdUrl`。
- 地区上下文：`contextFor`、`getCountryLanguageInfo`、`isCountryLanguageSupported`、`isMappable`。
- 高级组合：`execute`、`SHOP_ID`、`fetchIdentities`、`mapInto`。

参数、结果和身份类型继续导出。普通调用优先使用 `mapNsuid`；需要复用源身份、逐国处理失败的调用方可组合 `fetchIdentities` 与 `mapInto`，但需要自行校验输入、限制并发和目标数量。`isMappable` 是历史覆盖快照，未知国家也允许通过，不代表某商品一定可用。

此次精简对旧导入存在不兼容变更，客户端方法和匹配规则不变。废弃的 `isNsuid` 改用 `isCatalogId`；`fetchAppIds` 改用客户端的 `resolveNsuidsToAppIds`。默认常量、底层解析函数和重复地区清单不再从根入口公开。完整移除清单和替代方式见[迁移说明](README.md#migrating-from-the-previous-root-exports)，不要改成依赖内部文件路径。已有 vendor 副本需单独更新。

## 请求与错误

Savanna 和 Redirector 都对网络错误、HTTP 429 / 5xx 默认额外重试 2 次。
构造参数或单次调用的 `retries` 同时作用于两者，设为 `0` 可禁用，上限为 `5`。
全部尝试与退避等待共用单次请求的超时预算，默认 10 秒；超时、调用方取消和明确的非暂时错误不重试。

暂时 HTTP 错误会读取有效的 `Retry-After`，支持整数秒及 HTTP 日期；等待时间至少为服务器要求和本地退避两者的较大值。无效值使用本地退避，如果服务器指定的等待时间无法放进剩余预算，立即抛出原始错误，保留 HTTP `status` 和 `retryAfterMs`。`retryable: true` 表示调用方可稍后重试，不代表本次调用会继续等待。取消 / 超时会清除等待计时器；错误对象的可选 `retryAfterMs` 保存解析后的提示，单位毫秒。语义依据 [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)。

两套请求层的 `timeoutMs` 均只接受 `1`–`120000` 的整数毫秒；小数、非有限值、非正值或超出范围时，在请求前抛出 `TypeError`，不再静默取整或封顶。请求前、收到响应后均检查取消；Savanna 读取响应体成功后再检查一次，避免缓冲响应使已取消 / 超时的请求返回成功。

本体缺少应用编号、平台或权益时，先返回源身份不足的原因，不请求目标国家。
业务上的未匹配返回 `reason`；某国请求在重试后仍失败时，整个 `mapNsuid` 调用抛出 `NsuidMapError`，保持完整结果的约定。

未映射的目标带稳定的 `code` 和可读的 `reason`：`source_not_found`（源商品未返回）、`unsupported`（类型或合集成员没有跨区锚点）、`insufficient_identity`（上游缺少身份字段）、`unresolved`（目标 AppID 未解析）、`no_candidates`（目标区没有返回任何候选，常见于已下架或不可搜索的商品，不代表该区没有）、`no_match`（有候选但都不匹配；列表不含 `NOT_SALE` 商品，所以已下架的目标也可能落在这一类）、`ambiguous`（多个匹配）、`incomplete`（扫描未完成）。源身份无法映射时也带同样的 `code`。调用方按 `code` 分支，`reason` 的措辞可能调整；没有候选不等于目标区没有上架。

父 AppID 在目标区无跳转时会跳过，在成功解析的父商品返回的候选范围内比较完整身份，不删减成员。该范围内唯一匹配不保证枚举了目标区整个目录。扫描上限、分页截断或提前空页造成未完成时，不接受部分结果；网络、权限和 schema 硬错误仍会抛出。

单请求超时不等于整次映射的截止时间。多父商品或多页扫描可能更慢，需要总时限时传入取消信号：

```ts
await mapper.mapNsuid('70070000040805', {
  from: 'HK',
  to: ['JP', 'US', 'GB', 'AU'],
  signal: AbortSignal.timeout(30_000),
});
```

## 验证

```bash
bun run check          # 构建、类型、lint、格式及离线测试
bun run test:live      # 实际请求 Nintendo 接口
bun run example        # 运行示例，也会请求真实接口
LIVE=1 bun test tests/ # 全部测试，包含线上验证
```

真实样本仅保存匹配所需的身份字段。合成的异常分页、重复候选等测试与真实商品样本分开标注。线上数据可能变化，失败后需要核对实际响应；断言和 schema 错误不会被自动重试掩盖。

实测编号、回归覆盖和已知限制统一见[技术设计](docs/technical-design.zh-CN.md#验证样本)及其链接的测试文件。

开发工具使用 Bun；构建后的 ESM 库也兼容 Node.js 18.17 及以上版本。

## 许可

[MIT](LICENSE)
