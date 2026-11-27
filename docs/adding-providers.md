# 新增厂商或来源

注册表 `registry/providers.json` 是唯一配置入口；类型和运行时 schema 在 `src/shared/`，实现位于 `src/collector/adapters/`。先明确官方 URL、当前状态证据、配置产品／地域范围、原生事件能力和来源更新时间，不能先补一个默认全绿卡片。

## 接入步骤

1. 通过 `npm run probe -- --provider <已配置ID> --output .statusgrid/probes` 或受控公开请求记录 HTTP、最终 URL、编码、内容类型、SHA-256、真实采样时间及运行环境。只做公开读取；不记录 Cookie／凭证／页面 token。新 ID 先增加注册表合法配置再使用 CLI。
2. 检查原始响应能否同时证明目录、所有配置地域、当前事件和空列表含义。HTTP 200、SPA 空壳、空 RSS、目录成功不证明健康。页面挑战返回 blocked，不操作验证码。
3. 优先复用 `statuspage-v2` 等现有协议；新协议扩展 ProviderConfig 的 adapter 联合、`schemas.ts`、`public-schemas.ts` 与 `adapters/index.ts`，实现 `Adapter.collect`，返回 `AdapterResult`。适配器不直接写状态、不分配 episode、不发通知、不决定发布。
4. 为真实响应保存经审查的最小 fixture 和 provenance，加入正常／异常／维护／空／未知枚举／缺字段／挑战页／地域丢失／历史矛盾测试。构造异常必须明确标注，不能声称实际目击故障。非空当前与历史应分别验。
5. 对当前完整性声明 `evidence.requiredChecks`、`currentIncidentIds`，可选历史失败用 `historyError`；未知值返回明确失败或 null，不能映射 operational。来源当前状态与历史窗口是两项能力。
6. 注册表配置稳定 ID、分类、别名、排序、源站、端点、timeout/retries、requiredRegions 和 browserFallback；组件 ID 使用稳定上游标识，必要摘要必须披露改名／窗口风险。
7. 定向运行适配器测试和 `tests/shared/source-scope.test.ts`，再运行类型、lint、受影响事件／导出／前端检查。若公共字段变化，更新契约、schema、校验器、API 文档和预算测试。

真实来源样本可能随平台变更；解析器只能解码结构，禁止执行捕获的脚本、JSONP 或 eval。Next Flight 也只解码 JSON 字面量。浏览器交互声明普通步骤、精确 URL 和已验证的地域请求字段；每个来源独立 context、共享进程最多两项并发，取消后等待实际 disposal 才归还名额。协议永久卡死仍可能阻塞清理，需要运行层进程处置，不能报告虚假释放成功。

## G0～G3

| 门槛 | 必需证据 |
| --- | --- |
| G0 | 实际传输、编码、身份与时间，可回放来源记录 |
| G1 | 严格结构校验及异常／错误 fixture，未知字段形态不假绿 |
| G2 | 配置范围、当前状态、事件开始／恢复与有限窗口语义分别确认 |
| G3 | 目标 Runner 连续至少 12 轮定时实时完整成功，跨度至少 55 分钟 |

实现正确地 fail closed 不等于该源通过 G2。Azure 当前使用公开服务地域矩阵；RSS 只提供有限的发布时间信息，原生事件生命周期仍有限制。国内云仅代表注册表配置的地域；腾讯有限更新窗口的摘要身份不保证跨窗口唯一性。OpenAI 使用官方 incident.io 结构化页面，页面结构变化时须重新核对解析与覆盖，不能回退到缺失当前事件的兼容源。

先用 `--providers <id>` 做只读诊断；全厂商持久化禁止子集替换。新增来源由下一轮全量采集追加，保留已有事件、账本和不可变历史快照；旧快照仍按其原有厂商范围校验，新采集发布必须包含全部启用来源。扩容期间 frontend／retry 可以复用已经采集的范围，随后由正常 sync 纳入新来源。删除、改名或缩小已持久化来源范围需要显式迁移，不能删除目录重初始化。通过本地 G0～G2 后可进入预览，正式“稳定接入”仍需独立 G3。生产调度配置与运行检查见 [部署手册](deployment.md)。

## Flashduty 来源

MiniMax、StreamLake 使用通用 `flashduty` 适配器；DeepSeek 保留原 `deepseek` 类型与导入入口，内部共用相同解析器。新增同协议厂商时，优先在 `registry/providers.json` 添加配置：

- `adapter.type` 为 `flashduty`，`sourcePageId` 填官方页面返回的数字页面 ID；名称、域名及页面 ID 都会校验。
- `endpoints.page` 为官方状态页，读取服务端提供的完整组件目录和当前事件，JSON 数据只做解码。
- 页面内嵌原生日历历史时直接解析；列表模式可额外配置 `endpoints.history` 指向官方 `/history` 页面，读取带页面 ID 和月份的原生列表。
- `componentGroups` 可声明官网分组 ID 对应的展示名称。例如 MiniMax 的 Hailuo、H3 组件归入“视频生成”。

历史只代表官网返回的有限窗口。缺少当前目录／当前事件数组会导致采集失败；可选历史请求或解析失败只标记历史异常，保留已验证的当前状态。空 RSS／Atom 不能代替当前状态证据。完整接入仍需执行上面的来源验证、回归测试与目标 Runner 连续运行验收。

## AI 与开发平台

| 来源 | 类型 | 当前证据与历史 |
| --- | --- | --- |
| Devin、Factory | `statuspage-v2` | 官方 `/api/v2/summary.json`、独立 unresolved 当前列表、incidents 有限历史 |
| xAI | `xai` | `/api/status` 完整产品组件目录；`/api/incidents?status=active` 当前事件；`status=resolved` 有限历史 |
| OpenCode | `opencode` | 官方 `/api/status` 同一快照中的组件、事件、来源时间和过期标记 |
| Zed | `instatus` | 主页服务端结构化组件／当前事件；`/history` 月度有限窗口 |

Devin、Factory 的正常页面可以直接复用 Statuspage 协议；新增同类来源通常只需注册表配置、真实样本和验证。`componentGroups` 声明上游分组 ID 对应的展示名称。Statuspage 历史中时间矛盾等坏记录会逐条拒绝，保留其余有效事件，同时通过 `historyError` 和 partial 标明历史不完整。

xAI 的 `info` 是信息标记，不能当作故障严重度：组件状态保留 null 并披露 warning，`impact=none` 的官方事件作为 advisory 保留。OpenCode 聚合自身 Console／Inference 服务，套餐健康只覆盖官网监测的主要模型；按官网语义拒绝超过 3 分钟或已标记 stale 的监测快照，健康后尚未正式关闭的事件保留 monitoring，不能伪造恢复时间。

Instatus 配置必须固定 `sourcePageId`；同时校验页面名称和域名。Zed 的公开 summary 会省略空的当前事件数组，因此使用主页完整数据。解析只解码 Flight JSON，并跳过按 UTF-8 字节定长的文本记录。非空 generic notices 尚不支持，会明确返回覆盖不完整；不将未知公告静默视为无事发生。无可靠的原子来源更新时间时，`sourceUpdatedAt` 保留 null。
