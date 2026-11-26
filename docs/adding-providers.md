# 新增厂商或来源

注册表 `registry/providers.json` 是唯一配置入口；类型和运行时 schema 在 `src/shared/`，实现位于 `src/collector/adapters/`。先明确官方 URL、当前状态证据、配置产品／地域范围、原生事件能力和来源更新时间，不能先补一个默认全绿卡片。

## 接入步骤

1. 通过 `npm run probe -- --provider <已配置ID> --output .statusgrid/probes` 或受控公开请求记录 HTTP、最终 URL、编码、内容类型、SHA-256、真实采样时间及运行环境。只做公开读取；不记录 Cookie／凭证／页面 token。新 ID 先增加注册表合法配置再使用 CLI。
2. 检查原始响应能否同时证明目录、所有配置地域、当前事件和空列表含义。HTTP 200、SPA 空壳、空 RSS、目录成功不证明健康。页面挑战返回 blocked，不操作验证码。
3. 优先复用 `statuspage-v2` 等现有协议；新协议扩展 ProviderConfig 的 adapter 联合、`schemas.ts` 与 `adapters/index.ts`，实现 `Adapter.collect`，返回 `AdapterResult`。适配器不直接写状态、不分配 episode、不发通知、不决定发布。
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

实现正确地 fail closed 不等于该源通过 G2。当前 Azure 只验证公开矩阵及 RSS 的有限含义，原生事件生命周期仍未确认；国内云只代表配置地域；腾讯有限更新身份不保证跨窗口唯一性。完整来源限制与当前单轮结果见 [验收报告](acceptance-report.md) 和 [来源验证记录](superpowers/specs/2026-11-25-statusgrid-source-validation.md)。

先用 `--providers <id>` 做只读诊断；全厂商持久化禁止子集替换。改变已持久化来源范围需要显式迁移并保存事件／账本，不能直接缩小集合或删除目录重初始化。通过本地 G0～G2 后可进入预览，正式“稳定接入”仍需独立 G3。生产调度与来源延迟实测见 [部署手册](deployment.md)。
