# GitHub Actions 与 Pages 部署

本文是可执行部署说明。源码推送与正式部署验收是两个阶段；代码提交到 main 不代表 Pages、DNS、Runner 或稳定性已经通过。当前源码默认分支实际为 `main`，工作流与前端指纹检查均使用它，不需要创建名为 master 的分支。本地采集与恢复见 [运行手册](runbook.md)，尚未满足的线上门槛见 [验收报告](acceptance-report.md)。

## 仓库初始化与权限

1. 将通过本地检查的源码放在拥有管理权限的 GitHub 仓库 `main`，保留 lockfile、注册表、四个 `.github/workflows/*.yml` 和 `public/CNAME`。不要推送 `.statusgrid`、`dist`、生成 API／Feed、浏览器抓包或 fixture 发布目录。Fork 仓库需先启用 Actions，并确认默认分支上的定时工作流未被禁用。
2. Settings → Actions → General 允许本仓库所用官方 Actions。工作流默认只读，需要写入的 job 显式申请 `contents: write`、`pages: write`、`id-token: write`。组织策略必须允许这些授权，以及自动创建／更新 `data`、`gh-pages`；二者使用受 lease 保护的快照提交，分支保护规则若拒绝此类写入，发布会停止。不要放宽 `main` 的审查保护来绕过数据分支权限。
3. Settings → Pages → Build and deployment 的 Source 选择 **GitHub Actions**。确认 `github-pages` Environment 的分支／审批限制允许 `main` 的发布 job。这里使用官方 upload-pages-artifact 和 deploy-pages，不能只推送 gh-pages 就假定完成部署。
4. 默认公开来源不需要云账号密钥、腾讯密钥或自建 PAT。仓库 GITHUB_TOKEN 来自 Actions；生产日志不应加入 Cookie、token 或完整请求头。首次运行前检查外网可达和 Playwright Linux 依赖安装。

首次流程成功后，`data` 和 `gh-pages` 由代码在缺失时自动创建，无需手工塞入空 JSON。已存在的非生成或损坏目录会被拒绝，不能按首次启动清空。

## 首次发布顺序

1. 通过 push 到 main 或 PR 触发 **CI**（`ci.yml`），在 Actions 查看结果；该工作流没有手动 Run 入口。它验证 Node 22／24 的类型、lint、单元、构建、空态产物和浏览器用例，不采集真实上游、不写状态。
2. 手动运行 **Frontend release**（`frontend.yml`，选择 main）。它构建壳，与可用持久状态组合；首次无状态时发布明确 empty 站点，形成可复用的 durable shell 和发布收据。`gh-pages` 保存完整目录；初次尚无数据时 `data` 可以仍不存在。
3. 手动运行 **Collect and maintain status**（`sync.yml`），`mode=sync`、`interval=5`。它读取最新分支，在隔离 staging 完成真实采集、归并、状态和公共校验，然后先更新 data、再更新 gh-pages，最后上传完整 Pages Artifact 并显式部署。没有 durable shell 的 sync／retry 会拒绝，先补 frontend。
4. 查看发布 job 的部署 URL、验证步骤和 summary，再检查 `/api/v1/manifest.json` 的 live 模式、版本路径及 UI。`scripts/verify-deployment.ts` 只验证壳、manifest、summary 的真实预期 ID，不代替完整跨域／缓存／Runner 验收。

所有生产入口共享 `statusgrid-release` 并发组，`cancel-in-progress: false, queue: max`；可复用 pages 工作流不重复持锁。等待后才读取分支。分支 CAS 冲突意味着远端发生了未知变化，保留证据并重新读取，不强推覆盖。

## 周期与维护入口

默认定时为每小时 UTC 第 2、7、12……57 分钟。Repository variable `STATUSGRID_INTERVAL_MINUTES=10` 切换到第 2、12、22……52 分钟；未设置／5 使用 5 分钟。工作流包含两条 schedule，但 job 条件只选择配置对应的一条。

手动 `interval` 输入只影响该次调用；要长期 10 分钟必须设置仓库变量。页面提示自动使用实际快照 interval：两／三周期为 10／15 或 20／30 分钟。调度是目标，不保证严格实时；积压任务距离上一完整运行结束不足半周期时跳过，手动 sync 不受该跳过限制。被平台漏发／跳过的任务不算采集成功。

| sync.yml 的 mode | 行为 |
| --- | --- |
| sync | 全厂商真实采集、验证、写状态和完整发布 |
| diagnostic | 按 providers 输入只读采集；不更新状态、不发布；来源失败退出 1 |
| retry | 复用 data 状态和 gh-pages 壳，重新生成／校验／发布，不重新采集 |
| backup | 只校验并备份 data，Artifact 保留 30 天，不发布 |

每天 UTC 00:17 还自动运行 backup，不依赖该时刻是否有采集。无持久数据时明确 skipped；损坏数据备份失败而不生成“成功备份”。本机 `collect --interval` 没有自动调度；见运行手册的前台循环。

## data 成功而 Pages 失败

两个 Git 分支与 Pages 不是事务。若 data 已成功，后续 gh-pages CAS、上传、部署或可见性检查失败，该轮状态和通知账本仍可能已耐久保存。修复权限／分支冲突／平台错误后，在 sync 工作流手动选择 `mode=retry`。

retry 重新读取最新 data 和已校验 gh-pages 壳，不调用上游、不推进事件、不重复 triggered／escalated／resolved 里程碑。它可能因分支更新或壳损坏而停止；没有壳先执行 frontend。不要为了重发同一状态再次运行 sync，也不要用删除 data 的方式“修复”部署。

前端任务发布前比较 main 的前端输入指纹：文档提交不使有效壳过期，更新前端输入则放弃旧任务。发布收据同时保留源码 SHA 和输入指纹。故障恢复／备份还原细节见 [运行手册](runbook.md)，线上还原应经过分支审查和 CAS 检查。

## CNAME、DNS 与 TLS

仓库当前强校验 `public/CNAME` 为 `grid.thetamind.ai`，构建后带入站点，作为 StatusGrid 发布目录的域名一致性产物。**使用 GitHub Actions 发布时，Pages 自身忽略该 CNAME 文件；它不会配置或更改 Pages 的自定义域名与路由。** 管理员必须在 Pages 设置中配置同一自定义域名，并按 GitHub 的域名验证提示完成所有权验证，再在 DNS 管理商为 `grid` 配置指向 `<owner>.github.io` 的 CNAME，目标不要写仓库路径。这个项目按域名根路径构建；未配置自定义域名时，项目站点的 `/repository/` 子路径不能直接当作正式配置。官方说明见 [发布源配置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) 与 [自定义域名排障](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/troubleshooting-custom-domains-and-github-pages)。

等待 DNS 检查与证书签发完成，启用 Enforce HTTPS，核对浏览器证书、HTTPS 重定向和 CNAME 保留。不要提前假定证书已签发或为了演练改真实 DNS。更换域名涉及 CNAME、壳校验、Feed 链接生成及测试，需一并审查，不能只改 DNS。

## 正式上线前的目标验收

先在授权仓库／域名完成部署，然后保留下列实测结果，不能由本地 HTTP 200 推导：

- 每家来源 G0～G2 的配置覆盖和语义记录；Azure 原生事件生命周期等尚未确认能力继续披露。随后每家在目标 Runner **连续至少 12 轮定时**必需实时请求完整成功，跨度至少 55 分钟。受阻、跳过、手动运行均不计入；真实服务故障被正确采集仍是采集成功。
- 记录 schedule 应启动时刻、实际 startedAt／completedAt、各厂商 lastCheckedAt／lastSuccessAt／durationMs、sourceUpdatedAt（若源未提供记 null），及新 snapshot 首次在站点和浏览器可见的时间。分别计算任务延迟、来源已知更新时间差、发布可见延迟，不能混成“采集 5 分钟 SLA”。
- 使用 `curl -I https://grid.thetamind.ai/api/v1/manifest.json` 等保存 Cache-Control、Age、ETag、Date、Vary；比较正常请求、带不同查询参数请求、条件请求以及旧／新版本化路径，记录响应体 ID。查询参数和 `cache:no-store` 不保证绕过 CDN。
- 用不同 Origin 的真实浏览器请求 JSON／Feed，记录 `Access-Control-Allow-Origin` 和浏览器是否允许读取。curl 能读取不证明浏览器 CORS；Pages 头能力受平台限制。对摘要、详情、冷索引和月度 revision 做发布切换及旧版 404 恢复检查。
- 核对全部官方链接、UTF 编码、RSS／Atom、桌面／手机主题、每日页深链、断网和过期提示；在实际设备／网络记录 LCP 等性能。自动验证脚本不是全面可访问性审计。
- 完成真实部署失败重试、备份下载及隔离恢复演练；本地测试已覆盖相关分支语义，但外部 Actions 权限、排队、Artifact 与 Pages 可见性仍需实测。

G3 通过前只能称本地可用／目标部署待验，不标记正式稳定接入。发现来源间歇失败要单独归因，修复后重新计连续成功，不把多次手动采集拼成一个稳定窗口。
