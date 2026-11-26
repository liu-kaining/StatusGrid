# StatusGrid

面向 SRE 和架构师的免费基础设施状态看板，聚合 13 家云与 AI 服务的官方公开状态。

在线使用：**[grid.thetamind.ai](https://grid.thetamind.ai/)**

支持状态矩阵、组件／地域搜索、厂商详情、30 日轨迹与每日聚合、历史事件，以及 JSON / RSS / Atom。采集失败或历史缺失会明确标识；采样统计不代表厂商 SLA。国内来源范围为 AWS 中国北京／宁夏、腾讯云北京／上海、阿里云上海、百度云北京／上海。

## 本地运行

推荐 Node 24，也支持 Node 22.12 及以上的 22.x。

```sh
npm ci
npx playwright install chromium
npm run collect -- --state-dir .statusgrid/state --output-dir public --report .statusgrid/run.json
npm run dev -- --port 5174
```

打开 `http://127.0.0.1:5174`。Linux 安装浏览器时使用 `npx playwright install --with-deps chromium`。可通过 `STATUSGRID_BROWSER_EXECUTABLE` 指定已有浏览器。

`collect` 每次只采集一轮；本地持续采集见 [运行手册](docs/runbook.md)。页面刷新和 Vite 不会触发上游采集。`npm run preview:fixture` 可启动带演示标识的预览，供开发及浏览器测试使用。

## 自动更新

- GitHub Actions 默认每 5 分钟调度一次：每小时第 02、07、12……57 分钟。
- 仓库变量 `STATUSGRID_INTERVAL_MINUTES=10` 切换为第 02、12、22……52 分钟；手动运行的 interval 只影响当次。
- 每轮读取持久状态，采集全部来源，校验并保存数据，再发布 Pages；定时采集复用已构建的前端。
- 页面在前台每 60 秒检查新快照。没有更新时，5 分钟配置下在 10／15 分钟分别提示延迟／过期。
- 每天 UTC 00:17（上海时间 08:17）调度状态备份，Artifact 保留 30 天。

GitHub 的定时事件可能延迟或漏发，5 分钟是目标周期。确认自动运行请查看 Actions 中 `event=schedule` 的记录；手动运行成功不能代替该检查。配置与故障处理见 [部署文档](docs/deployment.md)。

## 数据存储

使用 GitHub 分支和静态 JSON 文件持久化，无独立数据库：

| 位置 | 内容 |
| --- | --- |
| `main` | 源码、工作流、注册表和必要测试 |
| `data` | 采集状态、事件、观测记录、日统计和通知去重账本 |
| `gh-pages` | 完整前端、公开 API 和 Feed；由 Actions 上传至 Pages |
| 本地 `.statusgrid/state` | 本机采集状态，Git 忽略 |
| Actions Artifact | 每日状态备份，保留 30 天 |

Runner 的临时目录用于处理当次任务；下一轮从 `data` 恢复状态。观测与日统计保留滚动 90 天，事件按月持续归档，因此总存储会随历史增长。存储布局、保留策略与恢复步骤见 [运行手册](docs/runbook.md)。

## 开发

```sh
npm run typecheck
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```

- [运行、诊断、备份和恢复](docs/runbook.md)
- [GitHub Actions / Pages 部署](docs/deployment.md)
- [公共 API、版本与 Feed](docs/api.md)
- [新增来源](docs/adding-providers.md)

历史设计、开发计划和旧验收材料保存在 `codex/archive-before-cleanup-20261127` 分支。
