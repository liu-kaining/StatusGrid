# Cloudflare 定时采集与 GitHub Pages 部署

本站部署在 `https://grid.thetamind.ai/`，源码默认分支为 `main`。本文说明部署顺序、自动更新和故障恢复；本地运行及数据布局见 [运行手册](runbook.md)。

## 仓库初始化与权限

1. 将通过本地检查的源码放在拥有管理权限的 GitHub 仓库 `main`，保留 lockfile、注册表、`.github/workflows/*.yml`、`workers/scheduler` 和 `public/CNAME`。不要推送 `.statusgrid`、`dist`、生成 API／Feed、浏览器抓包或 fixture 发布目录。Fork 仓库需先启用 Actions。
2. Settings → Actions → General 允许本仓库所用官方 Actions。工作流默认只读，需要写入的 job 显式申请 `contents: write`、`pages: write`、`id-token: write`。组织策略必须允许这些授权，以及自动创建／更新 `data`、`gh-pages`；二者使用受 lease 保护的快照提交，分支保护规则若拒绝此类写入，发布会停止。不要放宽 `main` 的审查保护来绕过数据分支权限。
3. Settings → Pages → Build and deployment 的 Source 选择 **GitHub Actions**。确认 `github-pages` Environment 的分支／审批限制允许 `main` 的发布 job。这里使用官方 upload-pages-artifact 和 deploy-pages，不能只推送 gh-pages 就假定完成部署。
4. 公开来源采集不需要云账号密钥。采集／发布使用 Actions 自带的 `GITHUB_TOKEN`；Cloudflare 调度使用下文单独创建的 GitHub 令牌，二者不同。生产日志不应加入 Cookie、token 或完整请求头。首次运行前检查外网可达和 Playwright Linux 依赖安装。

首次流程成功后，`data` 和 `gh-pages` 由代码在缺失时自动创建，无需手工塞入空 JSON。已存在的非生成或损坏目录会被拒绝，不能按首次启动清空。

## 首次发布顺序

1. 通过 push 到 main 或 PR 触发 **CI**（`ci.yml`），在 Actions 查看结果；该工作流没有手动 Run 入口。它验证 Node 22／24 的类型、lint、单元、构建、空态产物和浏览器用例，不采集真实上游、不写状态。
2. 手动运行 **Frontend release**（`frontend.yml`，选择 main）。它构建壳，与可用持久状态组合；首次无状态时发布明确 empty 站点，形成可复用的 durable shell 和发布收据。`gh-pages` 保存完整目录；初次尚无数据时 `data` 可以仍不存在。
3. 手动运行 **Collect and maintain status**（`sync.yml`），`mode=sync`。它固定按 5 分钟周期记录统计元数据，读取最新分支，在隔离 staging 完成真实采集、归并、状态和公共校验，然后先更新 data、再更新 gh-pages，最后上传完整 Pages Artifact 并显式部署。没有 durable shell 的 sync／retry 会拒绝，先补 frontend。
4. 查看发布 job 的部署 URL、验证步骤和 summary，再检查 `/api/v1/manifest.json` 的 `dataMode=live`、快照 ID、生成时间及 UI。看到空态页面表示前端已部署，真实采集完成后才有服务状态。

工作流的发布入口和校验地址固定为 `https://grid.thetamind.ai/`，不直接使用 deploy-pages 可能返回的 HTTP 地址。发布校验为每次尝试附加唯一查询参数，并发送禁止复用缓存的请求头；仍要求 manifest 和 summary 严格匹配本轮发布收据。边缘传播最多等待 120 秒，超时会中止请求并失败，日志保留预期／实际快照 ID、URL 和缓存响应信息。该校验不清理 CDN，也不改变访客的缓存规则；不能把其他轮次的快照当作本轮成功。

若 `configure-pages` 提示 `Get Pages site failed / Not Found`，检查 Pages 的 Source、管理员权限和组织策略。修正设置不会自动重跑失败任务，需手动再运行 Frontend release。只有测试或文档变化时，push 发布会因前端指纹未变而跳过；手动运行可用于初始化或恢复。

所有生产入口共享 `statusgrid-release` 并发组，`cancel-in-progress: false, queue: max`；可复用 pages 工作流不重复持锁。等待后才读取分支。分支 CAS 冲突意味着远端发生了未知变化，保留证据并重新读取，不强推覆盖。

## Cloudflare 每 5 分钟触发采集

执行链路为 **Cloudflare Cron → GitHub workflow_dispatch → 采集 → data → gh-pages → Pages 部署与线上验证**。`.github/workflows/sync.yml` 不再配置 GitHub `schedule`，但保留手动入口；不要在 GitHub 界面禁用整个工作流，否则 Worker 也无法触发它。

Worker 只负责发送触发请求，不采集、不存储状态。源码推送到 `main` 不会部署 Worker；需完成以下配置。先确保 `main` 已包含新的 `scheduled-at` 工作流输入，否则 API 会拒绝新参数。

### 1. 创建 GitHub 调度令牌

GitHub 头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token：

- 名称：`statusgrid-cloudflare-scheduler`。
- Resource owner：`liu-kaining`。
- Repository access：**Only select repositories**，只选 **StatusGrid**。
- Repository permissions：**Actions: Read and write**。Metadata 的只读权限由 GitHub 自动附带，无需添加 Contents 写入或 Workflows 权限。
- 设置有效期，并在到期前轮换 Cloudflare 中的 Secret；过期后自动触发会失败。

生成后将令牌直接保存到下面的 Cloudflare Secret。不要写入 Worker 源码、Git、普通文本变量或聊天记录。Worker 只用它触发工作流；后续采集与分支写入仍使用工作流自己的权限。权限依据见 [GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。

### 2. 在 Cloudflare 后台创建 Worker

1. 进入 **Workers & Pages → Create application**，创建一个 Hello World Worker，名称填 `statusgrid-scheduler`。
2. 打开 **Edit code**，用仓库 [workers/scheduler/index.js](../workers/scheduler/index.js) 的全部内容替换默认代码，点击 **Deploy**。这是可直接粘贴的 JavaScript，无需构建前端。
3. 进入该 Worker 的 **Settings → Variables and Secrets**，添加下列配置并部署：

   | 类型 | 名称 | 值 |
   | --- | --- | --- |
   | Secret | `GITHUB_TOKEN` | 上一步生成的 GitHub 令牌 |
   | Text | `GITHUB_REPOSITORY` | `liu-kaining/StatusGrid` |
   | Text | `GITHUB_REF` | `main` |

4. 在 **Settings → Observability** 启用 Workers Logs，方便检查触发成功和错误。
5. 在 **Settings → Triggers → Cron Triggers** 添加一条 `*/5 * * * *`。部分界面将该区域称为 **Trigger Events**。每小时 UTC 第 00、05、10……55 分钟触发，北京时间分钟数相同。
6. 这个 Worker 仅处理定时事件，不需要自定义域名；可在 **Domains & Routes** 关闭 `workers.dev` 和预览地址。网站 `grid.thetamind.ai` 继续使用现有 Pages，无需改 DNS。

首次创建／修改 Cron 最多可能需要约 15 分钟传播，传播期间可能错过计划时刻。新建 Worker 的 Past Cron Events 列表也可能延后显示，优先结合 Workers Logs 和 GitHub Actions 判断。后台入口及传播说明见 [Cloudflare Cron 文档](https://developers.cloudflare.com/workers/configuration/cron-triggers/)；Secret 配置见 [Cloudflare Secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)。

### 3. 后续用 Wrangler 管理（可选）

上面的后台方式已足够。需要从源码部署时，在仓库根目录使用 Node 22.12 及以上：

```sh
npx --yes wrangler@4.168.0 login
npx --yes wrangler@4.168.0 secret put GITHUB_TOKEN --config workers/scheduler/wrangler.json
npx --yes wrangler@4.168.0 deploy --config workers/scheduler/wrangler.json
```

`secret put` 在交互提示中输入令牌，不要将值写在命令行参数中。该方式复用后台已创建的 `statusgrid-scheduler`；首次配置建议按前面的后台步骤完成。使用其他仓库时，同时修改配置文件的 `vars`。

Wrangler 部署会以配置文件中的 `triggers.crons` 替换远端 Cron；采用 Wrangler 后统一在该文件维护，避免后台修改在下次部署时被覆盖。配置开启日志并关闭公开路由，不需要额外安装到本项目依赖。

### 4. 确认自动采集和发布

1. 在 Worker 的 Cron Events／Workers Logs 中检查连续定时执行。成功日志包含 `event=github_dispatch_accepted`、UTC `scheduledAt`、GitHub HTTP 状态和请求 ID；200／204 仅说明 GitHub 接受请求，不等于采集／部署成功。
2. 在 GitHub Actions → **Collect and maintain status** 检查对应运行。事件类型为 **workflow_dispatch**；名称类似 `Collect status · sync · Cloudflare 2026-11-27T04:05:00.000Z`。这里的例子对应北京时间 12:05。手动运行保持 `scheduled-at` 为空，名称显示 `manual`。
3. 检查 publish job 的采集、部署和线上验证步骤成功；比较相邻成功轮次的快照 ID、`generatedAt` 与 `providers[].collection`。工作流成功允许单个来源 stale，需分别检查来源采集情况。
4. 比较 `data`、`gh-pages` 发布收据和线上 `/api/v1/manifest.json` 的快照 ID、生成时间。验收至少连续三轮：计划时间相隔 5 分钟，每轮成功发布，线上快照持续推进。不要把 Git 分支提交时间当作新的采集时间。

页面在前台每 60 秒检查新快照。固定 5 分钟统计周期下，快照年龄达到 10／15 分钟时分别提示延迟／过期。5 分钟是触发目标，Actions 排队、浏览器安装、采集和发布仍会增加延迟；这一方案尚需真实定时运行验收。

### 5. 故障与暂停

| 现象 | 检查 |
| --- | --- |
| Worker 报 configuration 错误 | 三个绑定的名称、类型和值是否正确，是否已部署 |
| Worker 报 HTTP 401 | 令牌是否过期、撤销或粘贴错误 |
| Worker 报 HTTP 403 | Actions 写权限、令牌审批／组织策略和 API 限流 |
| Worker 报 HTTP 404 | 仓库权限、仓库名称、`sync.yml` 是否在 main |
| Worker 报 HTTP 422 | main 是否已有 `scheduled-at` 输入、ref 是否存在，以及工作流是否可手动触发 |
| GitHub 接受请求，但没有成功发布 | Actions 工作流是否启用、任务是否排队，以及具体失败步骤／Pages 权限 |
| Actions 成功，网站仍旧 | 对比快照 ID 和 `generatedAt`，再检查 Cloudflare 对 manifest／版本数据的缓存规则 |

Worker 对失败请求抛出错误，HTTP 请求最长等待 20 秒；代码每次执行只发送一次请求，不额外重试，避免请求已被接受时重复采集。下一次 Cron 会重新尝试。

暂停后台管理的 Worker：删除其 Cron Trigger，保留手动 GitHub 入口。Wrangler 管理时将 `triggers.crons` 改为 `[]` 再部署；只删除该配置项不会清除已有远端 Cron。取消／删除触发器同样需要传播时间；已经排队的 GitHub 任务不会因此取消。

## 手动维护与每日备份

手动 sync／diagnostic 也固定使用 5 分钟统计周期。旧的 `STATUSGRID_INTERVAL_MINUTES` 仓库变量不再生效，可以删除。

| sync.yml 的 mode | 行为 |
| --- | --- |
| sync | 全厂商真实采集、验证、写状态和完整发布 |
| diagnostic | 按 providers 输入只读采集；不更新状态、不发布；来源失败退出 1 |
| retry | 复用 data 状态和 gh-pages 壳，重新生成／校验／发布，不重新采集 |

备份由独立的 **Back up collected status**（`backup.yml`）每天 UTC 00:17（上海时间 08:17）触发，也可单独手动运行。它只校验并备份 data，不采集、不部署，Artifact 保留 30 天。无持久数据时明确 skipped；损坏数据备份失败而不生成“成功备份”。本机 `collect --interval` 没有自动调度；见运行手册的前台循环。

备份仍使用 GitHub 原生定时事件，可能延迟或漏发；Cloudflare Worker 只替换采集定时器。首个备份时刻后确认存在状态备份 Artifact，并下载到隔离目录执行恢复校验。

## data 成功而 Pages 失败

两个 Git 分支与 Pages 不是事务。若 data 已成功，后续 gh-pages CAS、上传、部署或可见性检查失败，该轮状态和通知账本仍可能已耐久保存。修复权限／分支冲突／平台错误后，在 sync 工作流手动选择 `mode=retry`。

retry 重新读取最新 data 和已校验 gh-pages 壳，不调用上游、不推进事件、不重复 triggered／escalated／resolved 里程碑。它可能因分支更新或壳损坏而停止；没有壳先执行 frontend。不要为了重发同一状态再次运行 sync，也不要用删除 data 的方式“修复”部署。

前端任务发布前比较 main 的前端输入指纹：文档提交不使有效壳过期，更新前端输入则放弃旧任务。发布收据同时保留源码 SHA 和输入指纹。故障恢复／备份还原细节见 [运行手册](runbook.md)，线上还原应经过分支审查和 CAS 检查。

已有旧发布升级统计算法时，读取会先验证旧状态，再仅在内存重算派生统计。如果重算改变了同一快照的内容，frontend／retry 会报 `Immutable snapshot/revision collision` 并保留旧发布。此时先执行正常 sync 创建新快照，再运行 frontend／retry；旧不可变版本继续保留。不要删除 data／公共目录或覆盖旧路径来绕过校验。首次无数据部署仍按前述顺序进行。

## CNAME、DNS 与 TLS

仓库当前强校验 `public/CNAME` 为 `grid.thetamind.ai`，构建后带入站点，作为 StatusGrid 发布目录的域名一致性产物。**使用 GitHub Actions 发布时，Pages 自身忽略该 CNAME 文件；它不会配置或更改 Pages 的自定义域名与路由。** 管理员必须在 Pages 设置中配置同一自定义域名，并按 GitHub 的域名验证提示完成所有权验证，再在 DNS 管理商为 `grid` 配置指向 `<owner>.github.io` 的 CNAME，目标不要写仓库路径。这个项目按域名根路径构建；未配置自定义域名时，项目站点的 `/repository/` 子路径不能直接当作正式配置。官方说明见 [发布源配置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) 与 [自定义域名排障](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/troubleshooting-custom-domains-and-github-pages)。

等待 DNS 检查与证书签发完成，启用 Enforce HTTPS，核对浏览器证书、HTTPS 重定向和 CNAME 保留。不要提前假定证书已签发或为了演练改真实 DNS。更换域名涉及 CNAME、壳校验、Feed 链接生成及测试，需一并审查，不能只改 DNS。
