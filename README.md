# StatusGrid

面向 SRE 和架构师的免费云与 AI 基础设施状态工具。聚合 13 家官方公开状态，提供实时矩阵、组件／地域搜索、厂商详情、UTC 每日轨迹与聚合页、历史事件库，以及 JSON / RSS / Atom。

服务状态和采集健康分开表达：采集失败保留上次可信内容并标记受阻；没有可信数据时显示无数据。历史缺失不补绿，采样统计不是厂商 SLA。国内云范围限定为腾讯云北京／上海、阿里云上海、百度云北京／上海。

本地功能、发布链路和验收工具已实现；目标域名为 `grid.thetamind.ai`，尚未执行正式部署和目标 Runner 连续观察。实际验证、来源限制和未满足项见 [验收报告](docs/acceptance-report.md)。

## 从新克隆启动真实数据

使用 Node 22（至少 22.12）或 Node 24；CI 检查两者，生产工作流使用 24。

```sh
npm ci
npx playwright install chromium
# Linux CI／服务器还需要系统依赖：npx playwright install --with-deps chromium
npm run collect -- --state-dir .statusgrid/state --output-dir public --report .statusgrid/run.json
npm run release:check -- --dir public --require-live
npm run dev -- --port 5174
```

打开 `http://127.0.0.1:5174`。采集运行一轮；Vite 和页面轮询不调度上游采集。下一次刷新上游需重新执行采集命令，或使用 [运行手册](docs/runbook.md) 中的显式本地循环。

只看已存在的发布目录可用 `STATUSGRID_DATA_DIR=.statusgrid/local/public npm run dev -- --port 5174`，不会改写数据时间。浏览器默认使用 Playwright Chromium，采集和测试均支持 `STATUSGRID_BROWSER_EXECUTABLE` 指定已安装浏览器；测试在 macOS 还可选择标准安装的 Chrome。

`npm run preview:fixture` 是独立演示预览（5173），有明确 fixture 标识，不代表真实状态，不能用于正式发布。未采集时 `npm run dev` 展示无数据页面。

## 使用与维护

页面每 60 秒检查已发布数据；手动刷新也只重新读取快照。5 分钟目标周期下，10／15 分钟分别提示延迟／过期；10 分钟周期对应 20／30 分钟。日轨迹按快照 UTC 日期锚定，悬停／聚焦展示覆盖与事件摘要，点击／Enter／触屏进入可分享每日页。过期快照保留历史，但不能验证当前服务。

```sh
# 只读来源诊断，不写持久状态
npm run collect -- --providers github,openai --report .statusgrid/diagnostic.json
# 工程验证；先安装 Chromium
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```

- [运行手册：采集、调试、备份和恢复](docs/runbook.md)
- [GitHub Actions / Pages 部署与上线验收](docs/deployment.md)
- [公共 API、版本与 Feed](docs/api.md)
- [新增来源与 G0～G3 门槛](docs/adding-providers.md)
- [本地验收、决策及剩余门槛](docs/acceptance-report.md)
- [总体设计](docs/superpowers/specs/2026-11-25-statusgrid-design.md)、[数据契约](docs/superpowers/specs/2026-11-25-statusgrid-data-contracts.md)、[来源验证](docs/superpowers/specs/2026-11-25-statusgrid-source-validation.md)、[每日下钻设计](docs/superpowers/specs/2026-11-26-statusgrid-day-drilldown.md)、[开发计划](docs/superpowers/plans/2026-11-25-statusgrid-implementation.md)

`.statusgrid/`、`dist/`、公共生成数据和测试输出被 Git 忽略；源码、注册表、测试 fixture 和正式文档属于交付内容。不要把演示数据或探测抓包提交成生产数据。
