# nsuid-mapper

把 Nintendo eShop 商品的 NSUID 映射为其他国家对应商品的 NSUID。

[English](README.md) · [技术设计](docs/technical-design.zh-CN.md) · [Redirector 行为](docs/apps-redirector.md)

这是独立的 Bun + TypeScript 项目，没有运行时第三方依赖。不需要发布到 npm；克隆后即可开发、运行示例和构建。

## 能力与边界

| 类型        | 映射依据                                                     |
| ----------- | ------------------------------------------------------------ |
| 本体 `7001` | 应用编号、平台、全部 ROM 权益，并检查基础版 / 升级版候选     |
| DLC `7005`  | 平台与完整权益集合，从父商品的分页列表及升级信息寻找唯一匹配 |
| 合集 `7007` | 平台、完整权益及全部成员身份；保留重复成员的数量             |

合集内的消耗品使用 `itemId` 和发行商 ID 比较，不依赖名称、文案或跨区变化的分组 ID。

独立体验版 `7003`、消耗品 `7009` 暂不映射；兑换券 `7002` 和课程券 `7008` 返回不支持的类型说明。上游未暴露的商品、身份信息不足、多个候选均匹配或分页未完成时，返回未映射原因，不猜测其他版本。

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
- `resolveNsuidsToAppIds`：同区批量查询应用编号，返回一个代表编号，不等于完整商品身份。
- `enumerateSkus`：查看 Redirector 的候选商品。
- `contextFor`：获取国家对应的查询语言。

完整参数和自定义 GraphQL 查询示例见 [英文 README](README.md)。

## 请求与错误

Savanna 和 Redirector 都对网络错误、HTTP 429 / 5xx 默认额外重试 2 次。
构造参数或单次调用的 `retries` 同时作用于两者，设为 `0` 可禁用，上限为 `5`。
全部尝试与退避等待共用单次请求的超时预算，默认 10 秒；超时、调用方取消和明确的非暂时错误不重试。

本体缺少应用编号、平台或权益时，先返回源身份不足的原因，不请求目标国家。
业务上的未匹配返回 `reason`；某国请求在重试后仍失败时，整个 `mapNsuid` 调用抛出 `NsuidMapError`，保持完整结果的约定。

## 验证

```bash
bun run check          # 构建、类型、lint、格式及离线测试
bun run test:live      # 实际请求 Nintendo 接口
LIVE=1 bun test tests/ # 全部测试，包含线上验证
```

真实样本仅保存匹配所需的身份字段。合成的异常分页、重复候选等测试与真实商品样本分开标注。线上数据可能变化，失败后需要核对实际响应；断言和 schema 错误不会被自动重试掩盖。

开发工具使用 Bun；构建后的 ESM 库也兼容 Node.js 18.17 及以上版本。

## 许可

[MIT](LICENSE)
