# StatusGrid

面向资深 SRE、架构师的免费云与 AI 基础设施状态工具。聚合官方公开状态，保留服务状态、采集健康度和事件来源，帮助排查上游影响。

目标覆盖 13 家厂商，默认采集周期 5 分钟，可配置为 10 分钟。目标域名为 `grid.thetamind.ai`；当前处于本地开发阶段。

## 当前阶段

任务 1～6 已完成本地实现与独立审查：工程契约、13 家注册表、HTTP 传输、隔离浏览器池、探测脚本、全部 13 家厂商适配器，以及事件状态机、持久历史和日统计。本地累计 205 项测试通过。OpenAI 使用官方 incident.io 页面，不再依赖缺少完整当前状态的旧兼容接口。

接下来实现公共 JSON / Feed、前端、自动调度和发布验收；当前尚无可用前端，也未部署。适配器存在不等于所有来源能力及 Runner 稳定性通过，具体限制见来源验证记录。

国内云首版显式覆盖腾讯云北京 / 上海、阿里云上海、百度云北京 / 上海。完整采集仅指配置地域，每个必需地域均须通过校验。OpenAI 本地采集出现过间歇传输失败；Azure 原生事件生命周期仍未确认，当前影响取自已校验的服务地域矩阵。

采集失败、未知状态和实时覆盖不足不会变成“正常”。缺少可信历史的首次失败显示无数据；后续失败保留上次可信内容，同时标记数据受阻。

## 本地开发

使用 Node.js 22.12 以上的 22 系列或 Node 24 以上；本机验证环境为 Node 22.23.0。

```sh
npm ci
npm run typecheck
npm run lint
npm run test:unit
```

浏览器池按需启动，普通 HTTP 采集无需浏览器。采集 CLI 可通过 `STATUSGRID_BROWSER_EXECUTABLE` 选择本机浏览器，未指定时使用 Playwright Chromium。浏览器测试的跨平台配置和目标 Runner 验证仍属于后续验收。

## 数据源探测

运行指定来源的单轮只读诊断：

```sh
npm run collect -- --providers cloudflare,github,claude,openai,moonshot --report .statusgrid/collection-run.json
```

添加 `--interval 10` 可将报告中的目标周期改为 10 分钟。命令运行一轮；自动调度在后续工作流中实现。每家失败独立记录，任一家未取得完整实时结果时诊断命令退出 `1`。OpenAI 通过官方 incident.io 页面的完整当前组件、事件和维护结构进行校验；覆盖不足时显示 `coverage_incomplete`。

单独保存原始传输证据：

```sh
npm run probe -- --provider aws-cn --output .statusgrid/probes
```

探测按注册表请求公开来源，保存原始响应、SHA-256、编码、采样时间和运行环境；请求失败时退出非零。HTTP 成功只证明传输可达，不证明业务状态或覆盖范围已验证。

`.statusgrid/` 是被 Git 忽略的本地生成目录。原始响应在提交为 fixture 前需要复查，不能将本地探测产物当成正式部署数据。

## 持久化采集

```sh
npm run collect -- --state-dir .statusgrid/state --report .statusgrid/run.json
```

该模式采集全部启用厂商，拒绝与 `--providers` 合用。厂商采集失败保留上次可信状态及未结束事件，并标记 `stale`；首次失败保持无数据。有效的持久化运行退出 `0`，配置、存储或契约错误退出 `2`，不能一概忽略非零退出。

`--state-dir` 指向独立生成根目录，其下包含 `state/`、`providers/`、`rollup/` 和 `incidents/`；因此最新快照位于 `.statusgrid/state/state/latest.json`。损坏分片、未知版本、未声明文件和并发覆盖会被拒绝，不作为首次初始化。不要把源码目录或探测目录作为生成根目录。

重复运行不重复事件和通知里程碑。官方事件不会仅因离开有限列表就被判恢复；观测故障仅在完整成功的范围恢复后关闭。日统计区分官方影响、观测影响和未知覆盖，不将采样结果视为厂商 SLA。公共数据导出尚未接通，当前 `--output-dir` 会明确拒绝。

## 设计与开发顺序

- [总体设计](docs/superpowers/specs/2026-11-25-statusgrid-design.md)
- [数据契约](docs/superpowers/specs/2026-11-25-statusgrid-data-contracts.md)
- [来源验证与接入门槛](docs/superpowers/specs/2026-11-25-statusgrid-source-validation.md)
- [开发计划与任务状态](docs/superpowers/plans/2026-11-25-statusgrid-implementation.md)

本地结构与语义验证通过后再做目标 Runner 观察；5 分钟是目标采集间隔，实际来源延迟、调度延迟和页面可见延迟分别记录。
