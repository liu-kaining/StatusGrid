# StatusGrid 数据源验证记录与接入门槛

日期：2026-11-25  
状态：开发前调查记录；不是 13 家接入完成报告。

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

这些外部约束由接入和部署验证负责跟踪，不影响本轮仅编写设计与计划的范围。
