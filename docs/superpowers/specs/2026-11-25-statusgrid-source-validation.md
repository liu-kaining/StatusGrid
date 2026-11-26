# StatusGrid 数据源验证记录与接入门槛

日期：2026-11-25  
状态：开发前调查与首批编码验证记录；不是 13 家接入完成报告。

## 1. 证据范围

本记录来自 2026-11-25 约 19:36（Asia/Shanghai）的本机 Node.js HTTP 请求及页面静态脚本检查。使用带项目标识的 User-Agent，请求公开状态资源，没有访问任何云账号中的资源。

当时没有将完整原始响应保存为测试 fixture，因此下列结果属于终端调查摘要。编码阶段必须通过探测脚本重新采样，保存可回放的脱敏样本与 metadata。

本机请求成功不代表 GitHub Runner 可达，不代表响应语义已完整解析，也不代表长期稳定。

## 2. 当前调查结果

| 厂商 | 请求 / 检查 | 本机结果 | 可以确认 | 尚待验证 |
| --- | --- | --- | --- | --- |
| Cloudflare | `https://www.cloudflarestatus.com/api/v2/summary.json` | 200；JSON；485 个组件 | 标准摘要接口可达 | 原生事件、节点折叠、未知枚举及 Runner |
| GitHub | `https://www.githubstatus.com/api/v2/summary.json` | 200；JSON；12 个组件 | 存在说明用占位组件，需要过滤 | 活跃 / 历史事件与组件覆盖 |
| Claude | `https://status.claude.com/api/v2/summary.json` | 200；JSON；10 个组件 | 组件数量与采集方案中的固定描述不一致 | 当前组件分组、事件与 Runner |
| OpenAI | `https://status.openai.com/api/v2/summary.json` | 200；JSON；25 个组件 | 摘要兼容接口存在，组件比“四大组”描述更细 | 缺少 `incidents` 字段时的活跃事件通道 |
| OpenAI | `https://status.openai.com/api/v2/incidents.json` | 200；返回 25 条事件 | 历史事件通道存在 | 分页、完整性、未恢复事件查询与时间字段语义 |
| Moonshot | `https://status.moonshot.cn/api/v2/summary.json` | 200；JSON；22 个组件 | 官方域名可达，含分组 / 子模型 | 分组身份、事件与 Runner |
| DeepSeek | `https://status.deepseek.com/api/v2/summary.json` | 404；JSON 错误 | 原 PRD 的标准适配器方案不适用本次响应 | 替代实时结构化数据通道 |
| DeepSeek | `https://status.deepseek.com/feed.atom` | 200；Atom | 官方订阅源可达 | 事件生命周期、历史窗口和结束时间 |
| DeepSeek | `https://status.deepseek.com/` | 200；包含 Flashcat 静态资源和 Next.js Flight | 页面含潜在组件数据 | 安全结构解析、语义与改版检测 |
| GCP | `https://status.cloud.google.com/incidents.json` | 200；JSON 数组 | 存在 begin / end / 产品 / 地域等字段 | 活跃事件映射、历史边界和产品关联 |
| GCP | `https://status.cloud.google.com/products.json` | 200；JSON，顶层 `products` | 产品字典可达 | 缓存、字典变更和孤立产品 ID |
| Apple 中国 | `https://www.apple.com/cn/support/systemstatus/data/system_status_zh_CN.js` | 404 | 采集方案中的地址需要修正 | 不作为生产数据地址 |
| Apple 中国 | `https://www.apple.com/support/systemstatus/data/system_status_zh_CN.js` | 200；JSON；54 项服务 | 去掉数据路径中的 `/cn` 后可达 | 真实事件字段、中文状态和 JSONP 变体 |
| Azure | `https://rssfeed.azure.status.microsoft/en-us/status/feed/` | 200；RSS | 订阅源可达 | 无事件时的正向校验、生命周期和公开覆盖范围 |
| AWS 中国 | `https://health.amazonaws.cn/public/currentevents` | 200；字节 `fe ff 00 5b 00 5d` | UTF-16BE，解码后为 `[]` | 非空事件、区域覆盖、状态语义和 Runner |
| 阿里云 | `https://status.aliyun.com/` | 200；SPA 外壳；主脚本可获取 | 页面及脚本可达 | 业务接口、地域参数、事件和完整成功断言 |
| 腾讯云 | `https://status.cloud.tencent.com/` | 200；SSR 中产品 / 地域为空，计数均为 0 | HTML 中的空值不能作为正常证据 | 实际加载通道、事件接口、可选只读 API |
| 百度智能云 | `https://cloud.baidu.com/status.html` | 200；页面与状态脚本可获取 | 脚本出现 `/dashboard/v1/` 下的地域、产品和事件请求 | 请求条件、业务响应与状态语义 |

组件数量仅描述本次样本，不应成为运行时断言。接口返回数组长度或 HTML 中的计数也不能单独证明服务健康。

## 3. 对原始文档的修正

1. DeepSeek 从标准 Statuspage 接入改为独立适配器。
2. Apple 中国的数据地址修正为 `/support/systemstatus/data/system_status_zh_CN.js`。
3. AWS 编码必须覆盖 UTF-8、UTF-16LE、UTF-16BE 及 BOM，不仅处理 LE。
4. OpenAI 摘要缺少事件字段时，要验证独立活跃事件通道，不能将缺字段当成空事件。
5. 组件 ID 保留为实体标识；名称用于可配置归类，不能作为唯一键。
6. 腾讯云 SSR 的空数组与全零计数代表“业务数据尚未证实”，不能判绿。
7. 阿里云目录请求成功不足以证明事件数据和所有配置地域采集成功。
8. 百度云不得直接按“异常产品达到 3 个”宣称严重宕机；先保留源严重度，派生规则需要明确标注和测试。
9. Playwright 是请求通道选择，不构成 WAF 可通过或数据可靠的保证。
10. 12～18 秒作为待测正常路径估计，不作为含超时重试的最大耗时保证。

## 4. 探测脚本输出设计

计划由 `scripts/probe.ts` 生成：

```text
.statusgrid/probes/{timestamp}/{providerId}/
├── metadata.json
├── responses/
│   ├── current.body
│   └── history.body
└── result.json
```

`metadata.json` 至少包括：

```json
{
  "providerId": "aws-cn",
  "checkedAt": "2026-11-25T11:36:00Z",
  "environment": "local",
  "sourceUrl": "https://health.amazonaws.cn/public/currentevents",
  "statusCode": 200,
  "contentType": "application/json;charset=utf-16",
  "encoding": "utf-16be",
  "durationMs": 1462,
  "bodyBytes": 6,
  "bodyHash": "sha256:<actual-response-digest>",
  "parserVersion": null,
  "semanticChecks": []
}
```

上面的 JSON 仅说明格式；时间、耗时和摘要必须由脚本生成，不能将示例作为采集事实写入 fixture。正式实现使用真实的十六进制 SHA-256 值。

默认不保存认证头、Cookie、云账号 ID、个人信息和带密钥参数的完整 URL。公开响应也需在加入版本库前复查脱敏；失败日志只保留必要的错误摘要。

## 5. 每家厂商的接入清单

| 门槛 | 交付物 | 通过条件 |
| --- | --- | --- |
| G0 传输 | metadata + 原始响应 | HTTP、编码、内容类型和最终 URL 已记录 |
| G1 结构 | 运行时校验 + fixture 测试 | 正常 / 异常 / 空 / 错误响应可区分，字段丢失不假绿 |
| G2 语义 | 覆盖说明 + 状态映射 + 生命周期用例 | 当前状态、地域、组件、事件开始 / 恢复含义明确 |
| G3 目标环境 | Runner 连续至少 12 次定时采集完整成功 | 跨度至少 55 分钟；不计受阻、跳过、手动运行；错误路径另外注入验证 |

G0 / G1 / G2 通过后可以进入开发预览；G3 通过才计入正式“已稳定接入”数量。

“采集完整成功”不要求厂商服务正常：正确获取并解析真实故障也算成功。任何必需实时请求受阻都中断连续成功序列，不能把正确返回 `stale` 计为接入稳定性通过。

没有官方事件样本时，建立明确的构造错误场景，但不将构造样本称为真实官方故障。尚未拿到非空事件样本的接口，其故障解析能力继续显示为待验证。

## 6. 官方平台约束的复核入口

以下资料在实现工作流和发布前复核，避免将平台行为写成项目自己的保证：

- GitHub Actions 事件与 schedule：`https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows`
- GitHub Actions 调度排障：`https://docs.github.com/en/actions/how-tos/troubleshoot-workflows`
- GitHub Pages 自定义工作流：`https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages`
- GITHUB_TOKEN 限制：`https://docs.github.com/en/actions/concepts/security/github_token`
- Azure 公开状态覆盖：`https://learn.microsoft.com/en-us/azure/service-health/azure-status-overview`
- Cloudflare 挑战与浏览器支持：`https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/`
- Vite 环境要求：`https://vite.dev/guide/`

这些外部约束由接入和部署阶段继续复核，不能由本机传输探测推定目标平台行为。

## 7. 首批编码的可复现传输证据

2026-11-25T13:54:44.857Z 使用项目探测脚本在本机重新采样，环境为 macOS arm64、Node 22.23.0。原始字节、运行环境、最终 URL、编码、耗时与 SHA-256 保存在被 Git 忽略的 `.statusgrid/probes/2026-11-25T13-54-44-857Z/`。这些是 G0 证据，不表示已实现专用解析器，也不表示 G3 通过。

| 来源 | 实际结果 | 证据 SHA-256 |
| --- | --- | --- |
| Apple 中国 `current` | HTTP 200；UTF-8 JSON；54 项服务 | `d0a2f9784e401b93ab956cb62fdce601a024a6ed0a22a84483ba54c8cecf34c1` |
| AWS 中国 `current` | HTTP 200；UTF-16BE；原始 6 字节解码为 `[]` | `bbf908a8ca98e2d204077c9a30192a1a36dc191b0d94adc68818281a240f7e9c` |
| DeepSeek `feed` | HTTP 200；UTF-8 Atom；13289 字节 | `a57d688d987479fa5e37569759f174cdc7303501f3f250e201393b831d2003ad` |
| DeepSeek `page` | HTTP 200；UTF-8 HTML；222876 字节 | `65f2f9e3425b1667b167e4c648bd90073d49ecd63967f292d91c672c312925e1` |

探测结果明确写入 `transport: success`、`parserVersion: null` 和空的 `semanticChecks`，不将 HTTP 200 表述为语义接入成功。公开原始响应仅保存在本机；提交的传输 fixture 是经过检查的最小样本。

同日复核标准来源发现：Cloudflare、GitHub、Claude、Moonshot 的 `incidents/unresolved.json` 可达；OpenAI 对应地址返回 404。OpenAI 正常摘要曾缺少 `incidents`，另一次异常摘要则包含活跃事件数组。因此，只有摘要明确提供完整事件数组或独立实时通道验证成功，才能认定活跃事件覆盖完整；有限历史列表不能代替此项验证。

## 8. 标准来源的原始样本

下列样本通过同一探测传输层保存到 `.statusgrid/statuspage-samples/`，均为本机 G0 证据。每家目录包含摘要、历史响应及 metadata；Cloudflare、GitHub、Moonshot 另外保存了独立未恢复事件响应。Claude 在并行采样中超时，随后单独重试成功，未把失败尝试计为成功。

Claude 的独立未恢复事件接口又于 2026-11-25T16:04:06.354Z 单独采样成功，证据保存在对应时间目录；这与较早的摘要属于不同次观测，不应拼成同一官方快照。

| 厂商 | 采样时间 UTC | 摘要 HTTP / 字节 | 摘要 SHA-256 |
| --- | --- | --- | --- |
| Cloudflare | 2026-11-25T14:16:53.599Z | 200 / 224304 | `833653d54ad47769e5709b6a8e48c2111f900b3cd0863d71719f28e49dea0d7f` |
| GitHub | 2026-11-25T14:16:53.600Z | 200 / 4310 | `a3f50238040ac8382fab107cae093bdefcdf19d859ae861e6d16710040a9deaf` |
| OpenAI | 2026-11-25T14:16:53.600Z | 200 / 7335 | `7c3dff9403fa608e982a01c0d77dc27228881ee28c8b511a98d69097e4a09755` |
| Moonshot | 2026-11-25T14:16:53.600Z | 200 / 7709 | `dbda42d6803a465af19a35ba0115c1e283c72df56bbf017caa211503524ea22a` |
| Claude | 2026-11-25T14:18:33.322Z | 200 / 6102 | `cd90f0b8af053fd05f6df1d7a9b17d2999b7d07f0b765caa9978a0d70ad216ad` |

结构差异已进入适配器需求：OpenAI 事件可缺少 `components`、`shortlink`、`started_at`，不得伪造范围或具体详情链接；Moonshot 时间包含时区偏移，输出需统一 UTC；Cloudflare 父组状态可能强于根摘要指标，需要保守归一化并提示冲突。解析和语义通过情况在适配器实现后另行记录。

## 9. 通用适配器的本地验证

Statuspage 通用适配器及生产 CLI 已实现；五家有源自真实响应的精简 fixture 和明确构造的失败场景。审查修复了独立 `scheduled_maintenances` 漏读以及必需事件接口返回 `null` 被误接受的问题；保存的 Cloudflare 完整响应已回放验证全量组件与维护记录。

本地 CLI 曾取得 Cloudflare、GitHub、Claude、Moonshot 的完整实时结果。根摘要、组件或当前事件严重度不一致时保守取值并输出 warning；有限历史候选与当前事件通过 `currentIncidentIds` 区分，历史补全失败单列 `historyError`。

OpenAI 的本地 CLI 最终取得了缺少 `incidents` 的正常摘要，因此输出 `missing / coverage_incomplete`，未生成可信当前结果。前两次请求超时同样保留真实失败。该来源的完整 G2 仍未通过，不能计为五家全部接入完成。所有来源 G3 均待目标 Runner 实际观察。

## 10. 专用来源调查补充（2026-11-26）

以下是适配器实现期间的公开来源证据，不能单凭这些样本宣布适配器或 G2 已通过。采样包含前一 UTC 日、同一上海自然日的数据；原始响应保存在被忽略的 `.statusgrid/source-samples/`。

| 来源 | 新确认的事实 | 实现约束 |
| --- | --- | --- |
| GCP | 同一官方 `incidents.json`、`products.json` 在本机 Node / curl 失败后，经普通 Chrome 导航取得 HTTP 200 | 可以在传输失败时使用精确端点的浏览器兜底；仍需相同的产品、地域和事件校验 |
| AWS 中国 | 官方应用声明分区 `aws-cn`；公开服务目录覆盖北京、宁夏；历史接口有非空真实事件 | 空当前列表须结合目录验证；不能再将原方案中的状态枚举视为事实 |
| 腾讯云 | 公开 GET 业务接口返回地域、产品、当前状态和分组历史；查询要求上海日期的 `EndDate` | HTTP 200 仍须检查业务错误、配置地域与产品覆盖；关闭的异常横幅不代表当前故障 |
| 阿里云 | 直接请求地域目录曾返回业务“不在白名单”；普通浏览器加载取得成功目录及当前、历史、进行中事件 | 通道差异须如实保留；不得绕过限制，也不得仅凭空稀疏映射判绿 |
| 百度智能云 | 直接业务请求返回 DEVICE sign error；普通浏览器及真实地域切换取得当前数据 | 使用页面自己的公开请求，按请求地域等待精确响应；不得复制页面 token 或账号式请求头 |
| OpenAI | 官方 incident.io 页面包含显式当前事件和组件目录；本次样本 37 项，旧兼容摘要 25 项 | 专用结构化解析就绪后替换不完整的兼容来源；数量仅为样本，不能成为断言 |

AWS 中国的官方目录为 `https://servicedata-cn-north-1-prod.s3.cn-north-1.amazonaws.com.cn/services.json`，历史为 `https://history-events-cn-north-1-prod.s3.cn-north-1.amazonaws.com.cn/historyevents.json`。官方应用枚举为 `0=resolved`、`1=impacted/info`、`2=degraded`、`3=disrupted`，与早期采集提案不同。历史顶层状态可能保留旧值，应结合最新明确日志或结束时间判定，不能靠标题中的“RESOLVED”恢复事件。

OpenAI 的当前页面使用 Next Flight。解析只解码 JSON 字面量，不执行 `self.__next_f`、`eval` 或捕获脚本；必须识别与官方页面身份匹配的完整摘要，检查组件、稀疏受影响组件、进行中事件和维护数组。多个冲突摘要或未知枚举均失败。有限旧历史接口可作回填，不能替代当前覆盖。该来源替换是为了修复已观察到的完整性差异，新增解析维护成本与失败受阻风险需继续保留。

Azure 的空 RSS 仍不是正常证据。官方页面的当前影响区和服务地域矩阵都需要结构及状态校验；仅找到一个正常单元格不足以覆盖其余单元格。RSS 发布时间不自动等于故障开始或结束时间。

对应证据目录包括 `gcp-browser/`、`2026-11-26T02-50-07-088Z/aws-services/`、`2026-11-26T02-50-07-092Z/aws-history/`、`2026-11-25T16-18-28-330Z/tencent-current/`、`2026-11-25T16-36-46-239Z/aliyun-browser/`、`baidu-region-interaction/` 和 `openai-browser/`。完整本地采集结果与 G0～G2 判定在对应任务验收后补充；G3 继续等待目标 Runner。
