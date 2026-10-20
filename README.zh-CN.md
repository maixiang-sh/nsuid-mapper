# nsuid-mapper

[English](README.md)

将 Nintendo eShop 商品的 NSUID 映射为其他国家同一商品的 NSUID。

非官方项目，与任天堂无关联，也未获其认可。

## 背景

NSUID 是商品在某个国家 eShop 中的 14 位编号。同一商品在不同国家的 NSUID 通常不同：

| 街头霸王 6 | NSUID            |
| ---------- | ---------------- |
| JP         | `70010000095202` |
| US         | `70010000095203` |
| GB         | `70010000095204` |
| HK         | `70010000095206` |

任天堂没有提供查询商品在其他国家 NSUID 的 API。

## 原理

本项目组合了任天堂的两个公开接口：

- **Savanna**：网页版 eShop 背后的 GraphQL API，返回商品的 application ID、platform 和 ROM rights。
- **`/apps` redirector**（`ec.nintendo.com/apps/{applicationId}/{country}`）：重定向到该国的商品页，重定向 URL 中包含 NSUID。

对每个目标国家，先通过 redirector 找到候选商品，再用 Savanna 返回的数据与源商品比较。只有恰好一个候选的身份与源商品一致时才返回结果。不比较名称。

接口和每一步的细节见[原理说明](docs/how-it-works.zh-CN.md)。

## 快速开始

需要 [Bun](https://bun.sh)。无运行时依赖。

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

每个目标国家要么有 `nsuid`，要么有 `code` 和 `reason`。程序应根据 `code` 判断；`reason` 供人阅读，措辞可能调整。

在其他项目中使用时，先运行 `bun run build`，再将本目录作为名为 `nsuid-mapper` 的本地依赖引入。本项目不发布到 npm。

## 支持的商品

| NSUID 前缀     | 类型       | 是否支持                                     |
| -------------- | ---------- | -------------------------------------------- |
| `7001`         | Title      | 支持                                         |
| `7005`         | DLC        | 支持                                         |
| `7007`         | Bundle     | 支持                                         |
| `7003`         | Demo       | 支持，前提是所属 title 在该平台只有一个 demo |
| `7009`         | Consumable | 不支持                                       |
| `7002`、`7008` | Ticket     | 不支持                                       |

即使两个国家都在销售，商品也可能无法映射，此时结果会给出原因而不是猜测。常见原因：

- 同一 title 在不同地区使用不同的 application ID，例如《怪物猎人 崛起》在 JP/HK 与 US/EU 各用一个。
- 多个商品的身份数据完全相同，例如 ROM rights 相同的几个 DLC。
- 商品在目标国家已下架，任天堂的列表中不包含它。

## 国家

支持 45 个国家，包括 JP、HK、US、CA、MX、BR、GB、AU、NZ 和欧洲大部分国家。KR、TW、中国大陆、东南亚、部分中东和拉丁美洲国家以及加勒比地区不支持，因为 redirector 在这些国家不返回商品页。见[国家列表](docs/reference.zh-CN.md#国家列表)。

国家使用两位 ISO 代码，例如 `JP`、`US`、`GB`。每次调用最多 8 个目标国家。

## 选项

```ts
const mapper = new NsuidMapper({
  timeoutMs: 15_000, // 单次请求的超时，默认 10000
  retries: 2, // 网络错误、HTTP 429 或 5xx 后的重试次数，默认 2
});

await mapper.mapNsuid('70070000040805', {
  from: 'HK',
  to: ['JP', 'US'],
  signal: AbortSignal.timeout(30_000), // 整次调用的时间上限
});
```

请求在重试后仍失败时抛出 `NsuidMapError`。全部方法、选项、结果代码和错误见[参考文档](docs/reference.zh-CN.md)。

## 开发

```bash
bun run check      # 构建、类型检查、lint、格式检查、离线测试
bun run test:live  # 请求任天堂线上接口的测试
bun run example    # 运行 examples/basic.ts，请求线上接口
```

## 文档

- [原理说明](docs/how-it-works.zh-CN.md)：术语、任天堂接口、各类商品的映射步骤
- [参考文档](docs/reference.zh-CN.md)：方法、选项、结果代码、错误、请求次数、国家

## 许可

[MIT](LICENSE)
