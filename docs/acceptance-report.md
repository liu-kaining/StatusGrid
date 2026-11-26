# 本地验收报告

日期：2026-11-26，测试机器为 macOS arm64，时区 Asia/Shanghai，证据时间均以 UTC 标明。范围包含 Task 1～10、历史菜单／轨迹配色调整及厂商＋UTC 日下钻。源码提交／推送与正式上线是不同阶段。

| 阶段 | 结论 |
| --- | --- |
| 本地实现与验证 | 两套真实 Node 运行时的安装、类型、lint、310 单元、38 浏览器、生产构建和空态产物通过；真实采集、发布与恢复结果如下 |
| 目标部署 | 未验收：尚无目标 Actions／Pages／DNS／TLS／缓存／CORS 证据 |
| 运行观察 | 未通过 G3：没有每家连续 12 轮、跨度至少 55 分钟的目标 Runner 定时成功证据 |

必要代码、测试 fixture、正式文档均受 Git 管理；本机完整运行报告、日志和截图保留在被忽略的 `.statusgrid/acceptance/`。这些路径是本机证据，不是新克隆必需文件。可复现命令见 [运行手册](runbook.md) 和 [部署手册](deployment.md)。

## 工程验证

同一代码修订分别实际执行，不以 engines 声明代替兼容测试：

| 命令 | Node 22.23.0 / npm 10.9.8 | Node 24.22.3 / npm 10.9.8 |
| --- | --- | --- |
| `npm ci` | 187 包；audit 0 漏洞；exit 0 | 187 包；audit 0 漏洞；exit 0 |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm run lint` | exit 0 | exit 0 |
| `npm run test:unit` | 32 文件、310 项，17.04s | 32 文件、310 项，15.57s |
| `npm run build` | 135 模块，305ms | 135 模块，299ms |
| `npx tsx scripts/workflow-release.ts check` | 生产空态完整壳 valid、snapshot empty | 同左 |
| `npm run test:e2e` | 38 项，31.0s | 38 项，26.1s |

安装日志保留现有 `eslint@9.39.5` 和 `whatwg-encoding` 弃用提示；未为消除提示擅自升级依赖。受管 Chromium 159.0.8154.6／Playwright build 1255 已实际安装；测试首先选择环境变量或已安装 Chromium，macOS 可回退标准 Chrome，不包含开发者 home 路径。Linux CI 明确安装 `--with-deps chromium`。CI 已补 22／24 矩阵，生产发布继续 24；真实 hosted matrix 仍待运行。

Playwright 配置清除子进程继承的 NO_COLOR，与其 FORCE_COLOR 保持一致；两套完整浏览器输出均没有原来的颜色冲突警告。该修正不忽略页面异常、console error 或失败请求。

构建体积：HTML 0.66 kB／gzip 0.46 kB，CSS 26.72 kB／gzip 6.21 kB，JS 368.30 kB／gzip 111.65 kB。摘要预算独立为 40 KiB，不能用 JS 体积替代摘要校验。

## 最终真实采集与来源门槛

最终验收使用独立 `.statusgrid/acceptance/state` 和 `public`，没有改写用户 `.statusgrid/local` 的数据或时间。Node 24 与受管 Chromium 实际执行生产 CLI：

```sh
npm run collect -- --state-dir .statusgrid/acceptance/state --output-dir .statusgrid/acceptance/public --report .statusgrid/acceptance/run.json
npm run collect -- --state-dir .statusgrid/acceptance/state --output-dir .statusgrid/acceptance/public --report .statusgrid/acceptance/run-retry.json
```

第一轮 `13:20:53.920Z–13:21:32.764Z`，38,844ms：12 家 fresh；OpenAI 首次 `missing/http_error`，38,832ms，未生成假正常。持久模式合法退出 0，失败证据保留。因该失败做完整复采，第二轮 `13:21:58.775Z–13:22:05.455Z`，6,680ms：**同一轮 13 家必需实时 fresh**，快照 `d0550c51-885c-48a5-9df1-5394cb21ffed`。没有拼接两次结果，也没有把这两轮手动运行计为 G3。

| 来源 | 第二轮服务状态／耗时 ms | 实际组件数 | 本地 G0／G1／G2 范围及残余限制 |
| --- | --- | --- | --- |
| Cloudflare | partial_outage / 1974 | 485 | G0/G1 通过；G2 当前组件／事件／维护已验证，有限原生历史 |
| GitHub | operational / 2464 | 11 | G0/G1 与当前 G2 通过；outcome=partial、freshness=fresh，可选历史 invalid_payload，历史 G2 不宣称完整 |
| Claude | major_outage / 1020 | 10 | G0/G1 与配置当前／生命周期 G2 通过；有限事件窗口 |
| OpenAI | degraded / 1636 | 37 | 官方 incident.io 当前 G0/G1/G2 通过；第一轮真实传输失败，维护形态为官方字段构造 fixture，无完整旧历史 |
| Moonshot | operational / 2176 | 22 | G0/G1 与配置当前／生命周期 G2 通过；组件分组及有限历史 |
| DeepSeek | operational / 395 | 7 | G0/G1 通过；G2 组件与原生历史形态验证，非空当前回放为构造；不从空 Feed 推健康 |
| GCP | operational / 372 | 238 | G0/G1 与目录／事件映射 G2 通过；无直接健康证据的目录组件状态 null，有限历史 |
| Apple 中国 | operational / 242 | 54 | G0/G1 与当前事件 G2 通过；名称摘要身份，改名变化，无完整历史保证 |
| Azure | operational / 3289 | 7902 | G0/G1 和公开服务地域矩阵 G2 通过；原生事件生命周期 G2 **未确认**，不能等同于全能力通过 |
| AWS 中国 | operational / 467 | 253 | G0/G1 与配置两区 G2 通过；14 项目录无地域保留 null；非空当前为真实历史转换构造样本，有限历史 |
| 腾讯云 | operational / 945 | 186 | G0/G1 与北京／上海配置 G2 通过；无稳定线程 ID，有限更新窗口身份风险，非完整原生历史 |
| 阿里云 | operational / 5032 | 121 | G0/G1 与上海当前 G2 通过；目录／当前／全局活跃联合校验，无完整原生历史声明 |
| 百度智能云 | operational / 4536 | 41 | G0/G1 与北京／上海当前 G2 通过；普通地域切换精确等待；名称身份，不用关闭横幅推断恢复 |

**所有来源 G3 均待验。** “适配器正确拒绝数据”不等于来源语义通过。G0/G1 的来源形态／错误行为由受管 fixture 和测试保留；上表组件数是该次实际结果，不是固定断言。Azure 两轮从 7893 变为 7902 项，程序仍按完整实际矩阵校验。

GitHub 当前成功而历史隔离的根因仍是官方历史 `6yk962mhlr3h` 开始晚于结束；未交换时间或补零。OpenAI 当前事件仍来自官方页面，保留 Codex GitHub reviews／pull request merges 事件。来源更新时间仅在 CF、GitHub、Claude、Moonshot、DeepSeek 实际提供；其余 null。已知更新时间早于采集完成不等于采集延迟，不能以状态未变化的时间差计算调度延迟。

## 发布与恢复

先独立验证无数据 `dist` 的完整壳及浏览器空态，再以 `prepareRelease` 将真实状态与同一构建组合到 `.statusgrid/acceptance/release`，复制该完整目录至 `dist` 后执行：

```sh
npm run release:check -- --dir dist --require-live
```

结果 valid=true、errors=[]、**73 个公共数据文件（54 JSON＋19 XML）**、摘要 **4,619 B gzip**、快照与第二轮一致。目录还包含前端壳、`.nojekyll` 和收据；73 不是站点总文件数。首轮和第二轮热版本及其冷引用均保留，fixture 未混入 live。

`backupState` 对真实状态生成 `backup.tar.gz`，在新的 `restored` 根解压，`loadState` 完整校验，并从恢复根组合 `restored-release`：valid=true、同一 snapshot、73 公共数据文件、4,619 B。`diff -qr` 核对恢复前后状态字节一致。解压首次出现环境 locale 提示，不影响 tar 退出 0 或校验；不是丢失数据的忽略错误。

以下失败／恢复行为由两套运行时完整单元和浏览器场景实际执行，均使用明确测试 fixture／本地 Git 仓库，不是线上故障演练：

| 场景 | 证据与边界 |
| --- | --- |
| 单来源失败 | runner 保留可信状态／失败新鲜度，其他来源仍发布；本轮 OpenAI 首次缺失后完整复采恢复亦为真实证据 |
| 全局漏跑 | freshness、rollup 和页面时钟场景覆盖两／三周期提示、失败截断和未知断档；未模拟出真实 Runner 成功 |
| 跨月、迟到恢复、重开 | events、storage、rollup、day、queries 验证 episode、旧月修订、UTC 半开区间和去重 |
| data 成功／Pages 失败 | publish 的本地真实 Git CAS 故障及 retry 场景，复用状态与壳，不重采或重复里程碑 |
| 损坏／并发拒绝覆盖 | storage/release 拒绝额外分片、语义错误、高版本、链接、锁及未知 CAS，原代保留 |
| 备份恢复 | publish fixture 场景及上述真实状态 tar／隔离恢复／完整重读／发布校验 |

同级 staging 和 rename 回滚不提供 fsync 崩溃持久性；进程突停可能遗留锁或 `.previous`，详见运行手册安全恢复步骤。

## UI、性能与可访问性

38 个 fixture 浏览器用例涵盖矩阵、搜索、抽屉焦点、错误、历史菜单键盘／触屏、URL 前进后退、深浅主题、390／1440px 无横向溢出、每日页和 hover 的真实关联内容。每日页还覆盖旧历史 404 后获取新 manifest／新事件且无需 reload／poll，失败重试、共享请求所有权、跨月持续事件、非法日期、有限覆盖和 fixture 标识。

历史信号保留绿／红／蓝／灰与下缘部分覆盖提示；自定义历史下拉支持实际选择 ARIA、键盘取消／提交和长列表滚动。轨迹每条仅一个 Tab 停靠点，箭头／Home／End、Enter、Escape 可用；触屏直接进入每日页。Header 没有新增顶层标签，App 导航清除旧 provider/date。

真实生产构建另跑 live 浏览器 **2/2，4.6s**，13 家真实卡片、Azure 7,902 项懒加载（初始 80，展开 160）、主题、OpenAI hover／每日事件和快照链接均通过；两视口 page／console／network errors 全部为空。测试按实际数据年龄区分 fresh 和 aged，该次 `13:25:05–13:25:06Z` 检查为真实 fresh，没有修改快照时间。用户 5174 原数据持续保留，其老快照自然过期。

生产浏览器截图保留在 `.statusgrid/acceptance/screenshots/`：`live-{1440|390}.png`、`live-light-{width}.png`、`live-azure-{width}.png`、`live-hover-{width}.png`、`live-day-{width}.png`、`live-day-light-{width}.png`。独立空壳截图为 `empty-{width}-{cold|warm}.png`，性能采样截图为 `live-{width}-{cold|warm}.png`。自查阅览桌面暗色矩阵／悬浮和手机浅色每日页，内容、覆盖说明和边缘布局正常。

对同一真实生产 `dist`，Vite preview 的本机回环地址、Chromium 159、1440×1050／390×1050、无 CPU／网络限速，每视口新 context 的一次冷导航与同 context 再导航测得：

| 页面／视口 | 冷 LCP ms | 热 LCP ms | 冷 DOMContentLoaded ms | 冷资源传输字节 |
| --- | --- | --- | --- | --- |
| 空壳 1440 | 516 | 32 | 464.3 | 120,072 |
| 空壳 390 | 312 | 28 | 267.1 | 120,072 |
| 真实 1440 | 452 | 44 | 375.9 | 141,230 |
| 真实 390 | 392 | 48 | 323.3 | 141,230 |

结果保留在 `empty-performance.json` 和 `live-performance.json`（包含 navigation／paint／resource），LCP 由页面初始 PerformanceObserver 记录。这里“冷”指新浏览器 context，未承诺系统／代理缓存全冷；各只有一个样本。资源字节是 Resource Timing 的传输观测，不含导航响应体，与摘要 gzip 预算是不同指标。本机新快照完成到检查可见约 180 秒，包含人工准备等待，不是 Pages 发布延迟；任务调度延迟、真正来源传播延迟及目标页面可见延迟均未测得。

自动检查不能覆盖屏幕阅读器、人类认知可用性、全键盘所有组合或全部 WCAG 项。尚无真机辅助技术审计。无 CPU／网络限速、本机 Chromium 的少量冷／热样本仅用于定位，LCP<1s 是受控优化目标，不承诺全球网络性能。

## 实施中确认的六项决策

| 决策 | 依据 | 若判断错误的成本 |
| --- | --- | --- |
| 浏览器 context 实际关闭才归还并发名额，pool.close 等待同一清理 | 真实 Chrome 复现隔离出并发 context/browser close 挂起；无需无证据重写进程架构 | 协议永久挂起仍可能占用名额／阻塞退出，需要进程级处置；必须报告，不能伪称回收 |
| OpenAI 使用官方 incident.io 结构化页 | 原兼容源缺当前事件，官方页完整组件及 ongoing_incidents 可验证；只解码 JSON | parser/schema 维护增加，改版会阻断来源；不得退回缺字段判健康 |
| 腾讯用厂商／地域／产品／首条已提供更新摘要，upstreamId=null | 仅证实更新 ID，没有线程 ID 或单事件 URL；共享首页会误合并故障 | 窗口截断可能产生额外事件／Feed 身份，不保证跨窗口唯一性，不猜别名 |
| 摘要新增与轨迹对齐的 30 组 dailyCoverage30d | 首页需要异常日缺失覆盖，无需下载全体详情 | 增加公开字段和摘要字节；继续执行 40 KiB 预算与对齐校验 |
| 公共冷索引 generatedAt 为内容 watermark，可 null | 不变冷内容需稳定字节，空索引不能伪造 epoch | 客户端必须支持 null；旧未发布预览需重生，内部状态分片保持原兼容 |
| Header 文件保持接口，App 既有 callback 负责每日页返回／清除 provider/date | 交互需要导航行为，不需要第三个顶层标签；已有类型回调可满足 | 每日页无独立顶层 tab；未来 Header 修改需保留 App callback 契约并跑导航测试 |

## 剩余验收与清理边界

正式上线还需要仓库 Actions／Pages 权限、Environment／分支规则、域名所有权／DNS／TLS、真实 hosted Node 矩阵、目标缓存键／头／CORS、各源 G3、schedule 延迟与浏览器可见延迟，以及真实部署／Artifact 恢复演练。步骤在 [部署手册](deployment.md)，这些项目均未勾为通过。

当前用户预览 `127.0.0.1:5174` 与 `.statusgrid/local` 是用户使用中的数据，不属于可删除临时内容。最终验收证据 `.statusgrid/acceptance` 和用户 UI 截图保留。旧 task 抓包、临时检查目录和计划执行 scratch 由主控在完整审查后按精确清单处理；本任务没有删除证据、原始 spec 或任何生成根。
