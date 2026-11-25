这 13 家厂商的数据源在底层技术架构上可精准划分为 **三大采集梯队**：**5 家**可直接复用一套 `Statuspage v2` 通用 JSON 解析器，**4 家**拥有公开无鉴权的专属 JSON/JSONP/RSS 接口，其余 **4 家**（集中在国内云与跨境受限站点）需采用“无头浏览器 XHR 拦截 + 官方只读 OpenAPI 双轨方案”。

---

## 零、 全局请求前置规范（必配防封禁策略）

在 GitHub Actions（默认位于美国 Azure 数据中心）发起请求时，所有 HTTP 客户端（`undici` / `fetch`）与 Playwright 实例必须统一注入以下基础配置，否则极易触发 Cloudflare 或国内云厂商 WAF 的精准拦截：

1. **显式可识别的 `User-Agent`（Cloudflare 官方硬性要求）**：
Cloudflare 状态页 API 文档明确规定：自动化轮询严禁使用默认脚本 UA（如 `node-fetch` 或 `undici`），必须携带包含站点 URL 或联系邮箱的自定义标识，否则将触发严格限流；国内站点（使用 Playwright 时）则切换为标准桌面 Chrome UA。
```http
User-Agent: StatusGrid/1.0 (+https://grid.thetamind.ai; contact@thetamind.ai)
Accept: application/json, application/xml, text/plain, */*

```


2. **超时与并发隔离**：海外站点单次超时设为 `8000ms`，国内站点（`.cn` 及国内云）跨境链路超时放宽至 `15000ms`，重试 2 次（间隔 `1500ms` 指数退避）。

---

## 一、 第一梯队：标准 Statuspage v2 兼容协议簇（5 家）

**适用厂商**：`Cloudflare`、`GitHub`、`Anthropic Claude`、`OpenAI`、`Moonshot (Kimi)`。

这 5 家虽然底层托管商不完全相同（例如 OpenAI 已迁移至 `incident.io`），但全部对外暴露并兼容 **Atlassian Statuspage v2 公开 JSON 规范**，无需任何 API Key，**仅需编写 1 个通用适配器即可全部跑通**。

### 1.1 统一请求端点与核心 JSON 字段路径

* **实时汇总与未恢复故障（每 20 分钟主轮询接口）**：`GET {baseUrl}/api/v2/summary.json`
* **最近 50 条历史 Case（用于初始化与补全复盘记录）**：`GET {baseUrl}/api/v2/incidents.json`

```text
summary.json 核心提取路径：
├── page.updated_at                     → 源站数据更新时间 (ISO8601)
├── status.indicator                    → 全局严重度: "none" | "minor" | "major" | "critical" | "maintenance"
├── components[]                        → 子服务组件列表
│   ├── id                              → 组件唯一 ID
│   ├── name                            → 组件名称 (如 "API", "ChatGPT")
│   ├── status                          → "operational" | "degraded_performance" | "partial_outage" | "major_outage" | "under_maintenance"
│   ├── group                           → 布尔值 (true 代表它是分组标题容器，非实体服务)
│   └── group_id                        → 所属父分组 ID (用于拼装树形结构)
├── incidents[]                         → 当前活跃未恢复事件 (investigating / identified / monitoring)
│   ├── id / shortlink                  → 事件唯一 ID 与官方短链跳转地址
│   ├── name                            → 故障标题
│   ├── impact                          → "none" | "minor" | "major" | "critical"
│   ├── created_at / resolved_at        → 故障开始时间 / 恢复时间
│   └── incident_updates[]              → 事件排查进展时间线 (status, body, display_at)
└── scheduled_maintenances[]            → 当前进行中或即将开始的维护窗口

```

**统一状态映射规则**：

* `status.indicator` 为 `"none"` → `operational`；`"minor"` → `degraded`；`"major"` → `partial_outage`；`"critical"` → `major_outage`。
* 若 `scheduled_maintenances[]` 中存在 `status === "in_progress"` 且无更高优故障 → `maintenance`。

### 1.2 五家厂商的独立 URL 与专属避坑清单

| 厂商 | `baseUrl` | 专属数据清洗与实战踩坑点（必看） |
| --- | --- | --- |
| **Cloudflare** | `[https://www.cloudflarestatus.com](https://www.cloudflarestatus.com)` | **组件爆炸陷阱**：`components[]` 返回超过 **300 个**全球机场边缘节点（如 `LAX - Los Angeles`）。**过滤策略**：仅保留顶层核心业务组（`Cloudflare Sites and Services`、`CDN/Cache`、`DNS`、`Workers`、`Zero Trust`）；机场物理节点仅在 `status !== "operational"` 时动态透出，否则卡片会被几百个节点撑爆。 |
| **GitHub** | `[https://www.githubstatus.com](https://www.githubstatus.com)` | **脏组件过滤**：GitHub 的 `components[]` 中常年混有一个名为 `"Visit [www.githubstatus.com](https://www.githubstatus.com) for more information"` 的占位说明项，解析时必须按名称或 ID 将其剔除。核心保留项为 `Git Operations`、`API Requests`、`Webhooks`、`Actions`、`Pages`、`Packages`、`Copilot`。 |
| **Claude** | `[https://status.claude.com](https://status.claude.com)` | 结构极其干净。重点提取五大核心组件：`claude.ai`、`Claude Console (platform.claude.com)`、`Claude API (api.anthropic.com)`、`Claude Code` 与 `Claude on Cloud Platforms`。 |
| **OpenAI** | `[https://status.openai.com](https://status.openai.com)` | **ID 迁移陷阱**：OpenAI 底层切换至 `incident.io` 后，虽保留了 `/api/v2/summary.json` 兼容层，但所有 `component.id` 和 `incident.id` 已由旧版 12 位短码变更为 **26 位 ULID**（如 `01KT5XJ5...`）。**切勿硬编码旧版组件 ID**，应直接按组件 `name`（`API`、`ChatGPT`、`Sora`、`Playground`）匹配。 |
| **Moonshot** | `[https://status.moonshot.cn](https://status.moonshot.cn)` | **域名脑裂陷阱**：切勿请求 `status.kimi.com`（DNS 无法解析）或旧版 `moonshot.instatus.com`（已废弃但永远显示绿灯，存在严重误导）！必须严格锁定 `[https://status.moonshot.cn/api/v2/summary.json](https://status.moonshot.cn/api/v2/summary.json)`。其组件包含分组结构（如 `Kimi Code` 组下挂载 `K3.1 Pro`、`K3` 等子模型），需利用 `group_id` 归拢展示，并重点高亮 `Open API` 行。 |

---

## 二、 第二梯队：公开无鉴权专用接口簇（4 家）

这 4 家采用自研或新兴状态页架构，各自提供无需登录的公开数据源，每家需编写约 50 行的轻量级独立解析器。

### 2.1 DeepSeek（底层为 Flashcat / Flashduty 状态页体系）

* **关键避坑预警**：早期的第三方镜像 `deepseek.statuspage.io` 已停止同步更新，在官方发生故障时仍会误报全绿！`status.deepseek.com` 现由 **Flashcat（Flashduty）** 驱动。
* **双通道获取路径**：
1. **官方故障订阅流（主推拉取历史与活跃事件）**：
* `GET [https://status.deepseek.com/feed.atom](https://status.deepseek.com/feed.atom)`（或 `[https://status.deepseek.com/feed.rss](https://status.deepseek.com/feed.rss)`）
* **说明**：直接返回标准 XML 事件流（包含故障标题如 `DeepSeek API 性能下降`、唯一链接 `[https://status.deepseek.com/incidents/](https://status.deepseek.com/incidents/){数字ID}`、起止时间与受影响组件）。注意该接口无浏览器 CORS 响应头，但由 GitHub Actions 服务端直接请求完全不受限制。


2. **实时组件级状态与 90 天可用率**：
* 先探测 Flashduty 公开快照接口（如 `summary.json` 兼容端点）；同时 `GET [https://status.deepseek.com/](https://status.deepseek.com/)` 首页 HTML 内置了完整的 **Next.js SSR Flight 数据块**（正则提取页面底部 `self.__next_f.push(...)` 中的 JSON 负载）。
* **关键组件清单**：可精确提取全部 7 个官方组件的实时状态与可用率百分比：`DeepSeek V4 Pro API服务`、`DeepSeek V4.1 Flash API服务`、`搜索API服务`、`抓取API服务`、`对话服务`、`上传文件服务`、`搜索服务`。





### 2.2 Google Cloud（纯静态双 JSON 文件架构）

GCP 的状态页本质上就是两个托管在边缘 CDN 上的公开 JSON 文件，极度适合自动化采集：

* **接口地址**：
1. 故障全量与实时库：`GET [https://status.cloud.google.com/incidents.json](https://status.cloud.google.com/incidents.json)`
2. 产品字典映射表：`GET [https://status.cloud.google.com/products.json](https://status.cloud.google.com/products.json)`（可每 24 小时缓存一次，将产品 ID 翻译为 `Vertex AI`、`Google Compute Engine` 等名称）


* **JSON 关键字段路径（`incidents.json` 数组元素）**：
* **判定当前是否活跃**：检查 `end` 字段——**当 `!item.end`（字段缺失或为空字符串）时，代表该故障正在发生**！
* **严重等级映射**：读取 `status_impact` 字段：
* `"SERVICE_OUTAGE"` → `major_outage`
* `"SERVICE_DISRUPTION"` → `partial_outage`（若 `severity === "low"` 则降为 `degraded`）
* `"SERVICE_INFORMATION"` → `degraded`


* **受影响产品与地域**：`affected_products[].title`（产品列表）、`currently_affected_locations[].id`（如 `asia-east1`、`us-central1`）。
* **官方详情直跳拼接**：`'[https://status.cloud.google.com/](https://status.cloud.google.com/)' + item.uri.replace(/^\//, '')`。



### 2.3 Apple 中国区系统状态（静态 JSON / JSONP 数据源）

`[https://www.apple.com/cn/support/systemstatus/](https://www.apple.com/cn/support/systemstatus/)` 前端页面本身不包含状态数据，而是异步加载一份结构化中文脚本文件：

* **接口地址**：
* 中国区全量中文状态：`GET [https://www.apple.com/cn/support/systemstatus/data/system_status_zh_CN.js](https://www.apple.com/cn/support/systemstatus/data/system_status_zh_CN.js)`（国际区对照源为 `[https://www.apple.com/support/systemstatus/data/system_status_en_US.js](https://www.apple.com/support/systemstatus/data/system_status_en_US.js)`；若你还关注推送证书 APNs 等开发者基础设施，可同步拉取 `[https://www.apple.com/support/systemstatus/data/developer/system_status_en_US.js](https://www.apple.com/support/systemstatus/data/developer/system_status_en_US.js)`）。


* **外壳剥离处理（关键细节）**：
部分路径直接返回纯 JSON，部分路径包裹了 `jsonCallback({...});`。解析前统一做三行清洗即可免疫格式差异：
```typescript
const raw = rawText.trim();
const cleanJson = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'));
const payload = JSON.parse(cleanJson);

```


* **JSON 关键字段路径与推导公式**：
* `payload.services[]`：包含约 60 项 Apple 服务（`serviceName`: 如 `"App Store"`、`"iCloud 云盘"`、`"Apple Pay"`）。
* `service.events[]`：该服务关联的当前及近期事件数组。
* 当所有服务的 `events[]` 中均不存在 `eventStatus === "ongoing"` 的记录时 → 全局判定为 `operational`！
* 当存在 `eventStatus === "ongoing"` 时，按 `statusType` 映射：`"Outage"` → `major_outage`；`"Issue"` → `partial_outage`；`"Performance"` → `degraded`；`"Maintenance"` → `maintenance`。
* 时间戳字段 `epochStartDate` 与 `epochEndDate` 均为毫秒级 Unix 时间戳，可直接生成历史回溯记录。





### 2.4 Microsoft Azure（官方公开 RSS 流 + SSR 状态页双校验）

* **架构现状**：Azure 的细粒度资源健康 REST API（`Microsoft.ResourceHealth`）强制要求绑定企业 Azure Subscription ID 与 OAuth 鉴权；面向公众的全局状态页仅通报广泛性故障。
* **免鉴权获取路径**：
1. **主数据源（官方全球事件 RSS）**：`GET [https://rssfeed.azure.status.microsoft/en-us/status/feed/](https://rssfeed.azure.status.microsoft/en-us/status/feed/)`（备用镜像：`[https://azure.status.microsoft/en-us/status/feed/](https://azure.status.microsoft/en-us/status/feed/)`）。
* 解析 XML 中的 `<channel><item>`：`title`（通常带有 `Active - ...`、`Investigating - ...`、`Observing improvements - ...` 前缀）、`description`、`pubDate`、`guid`。


2. **辅助核验源（HTML 顶部全局横幅解析）**：`GET [https://azure.status.microsoft/en-us/status](https://azure.status.microsoft/en-us/status)`。
* 用轻量级 `cheerio`（无需启动无头浏览器）读取服务端直出的全局状态提示块与各区域表格（美洲、欧洲、亚太、Azure Government）中的非 `"Good"` 状态单元格，防止某次故障恢复后 RSS 未及时清空导致状态残留。





---

## 三、 第三梯队：国内云与重度前端渲染站点（4 家深度攻坚方案）

`AWS 中国`、`腾讯云`、`阿里云`、`百度智能云` 是整个项目中最容易踩坑的部分。它们普遍存在 **SPA 动态渲染、无公开免鉴权静态 `summary.json`、以及对海外数据中心裸 HTTP 请求的 WAF 拦截**。

**核心架构解法**：在采集任务中启动 **1 个共享的 Playwright Chromium 实例**，并发打开 4 个独立标签页，使用 **`page.on('response')` 底层网络数据包拦截**（直接截获网页自身 JS 成功拉回来的干净 JSON，而不是去写容易碎的 CSS DOM 选择器）。同时，针对腾讯云等提供官方健康看板 API 的厂商，预留“官方只读密钥直连通道”。

### 3.1 AWS 中国区（`[https://health.amazonaws.cn/health/status](https://health.amazonaws.cn/health/status)`）

AWS 中国区（由北京光环新网 `cn-north-1` 与宁夏西云数据 `cn-northwest-1` 独立运营）复用了全球版 AWS Health Dashboard（`health.aws.amazon.com`）的前端架构。

* **路径 A：直接请求底层公开事件 JSON（优先尝试，耗时小于 2 秒）**
* 全球版 AWS 状态页的真实后端公开 JSON 地址已验证为 `[https://health.aws.amazon.com/public/currentevents](https://health.aws.amazon.com/public/currentevents)`；中国区对应同构端点为 `[https://health.amazonaws.cn/public/currentevents](https://health.amazonaws.cn/public/currentevents)`。
* **著名编码巨坑（UTF-16LE BOM）**：AWS 的 `currentevents` 接口在部分 CDN 节点返回的是 **带有 `FF FE` BOM 头的 UTF-16LE 编码字节流**，直接调 `res.json()` 会报语法解析错误！必须先拿 `ArrayBuffer` 检查前两个字节：
```typescript
const buf = Buffer.from(await res.arrayBuffer());
const text = (buf[0] === 0xff && buf[1] === 0xfe) ? buf.subarray(2).toString('utf16le') : buf.toString('utf8');
const events = JSON.parse(text);

```


* **JSON 关键字段**：返回当前活跃事件数组（**空数组 `[]` 即代表北京区与宁夏区全部云服务运行正常**）。非空时包含：`service_name`（如 `Amazon EC2 (Beijing)`）、`region`（`cn-north-1` 或 `cn-northwest-1`）、`summary`、`date`（秒级时间戳）、`status`（枚举值 `0` 至 `3`：`0`=通知/已恢复，`1`=性能降级，`2`=服务中断，`3`=严重宕机） 以及 `event_log[]` 进展数组。


* **路径 B：Playwright 网络拦截兜底**
* 若跨境直连被连接重置或返回 403，用共享 Playwright 打开 `[https://health.amazonaws.cn/health/status](https://health.amazonaws.cn/health/status)`，拦截 URL 匹配 `/public\/(current)?events/` 的响应体即可拿到完全一致的 JSON。



### 3.2 腾讯云（`[https://status.cloud.tencent.com/](https://status.cloud.tencent.com/)`）—— 强烈推荐“官方 OpenAPI + 网页拦截”双模

腾讯云是国内云厂商中对自动化监控最友好的一家，它专门上线了免费的官方健康看板产品 **TCHD** 接口。

* **方案一（SRE 首选稳态方案）：调用腾讯云 TCHD 官方 OpenAPI 3.0（永不触发反爬、毫秒级响应）**
* **准备**：使用任意腾讯云账号创建一个**零权限费用的只读子账号**（仅授予 `QcloudTCHDReadOnlyAccess` 只读策略），将 `TENCENT_SECRET_ID` 与 `TENCENT_SECRET_KEY` 存入 GitHub Actions Secrets。
* **接口端点**：`POST [https://tchd.tencentcloudapi.com](https://tchd.tencentcloudapi.com)`（API 版本 `2023-03-06`）
* **两个核心 Action**：
1. `DescribeEventStatistics`：直接返回全网产品实时健康统计数（正常产品数、告警/通知产品数、异常故障产品数）。
2. `DescribeEvents`：传入近 30 天的起止日期（`EventDate`），直接返回标准化的结构化事件列表（含产品名、地域名、事件标题、当前状态、开始与恢复时间）。




* **方案二（零密钥免配置方案）：Playwright 拦截网页 XHR**
* 当环境变量未配置腾讯云密钥时，自动降级为 Playwright 访问 `[https://status.cloud.tencent.com/](https://status.cloud.tencent.com/)` 及历史页 `[https://status.cloud.tencent.com/history](https://status.cloud.tencent.com/history)`，直接拦截页面加载时发往健康看板网关的 JSON 响应包（提取各可用区产品矩阵与未恢复事件列表）。



### 3.3 阿里云（`[https://status.aliyun.com/#/?region=cn-shanghai](https://status.aliyun.com/#/?region=cn-shanghai)`）

阿里云状态页采用前端 Hash 路由（`#/?region=...`）的单页应用架构，不提供公开无鉴权的静态 JSON 或全局 RSS，且带有阿里云滑动/Cookie WAF（`acw_tc`）。

* **标准解析方案（Playwright 网络响应拦截 + 双重断言）**：
1. **页面导航**：在共享 Chromium 上下文（配置 `locale: 'zh-CN'`，屏蔽图片与字体请求以提速）中打开 `[https://status.aliyun.com/#/?region=cn-shanghai](https://status.aliyun.com/#/?region=cn-shanghai)`。
2. **拦截核心 XHR JSON**：监听 `page.on('response')`，捕获所有 `Content-Type` 包含 `application/json` 的同源/API 网关响应。阿里云前端在初始化时会并行拉取两类核心 JSON：
* **基础元数据**：全部可用地域字典（`cn-hangzhou`、`cn-shanghai`、`cn-beijing`、`cn-shenzhen`、`cn-hongkong` 等）及云产品分类树（计算 ECS、网络 SLB/VPC、存储 OSS、数据库 RDS、人工智能百炼等）。
* **异常健康事件列表**：查询各地域当前活跃及近期已恢复的异常事件数组（包含受影响 `regionId`、`productId`、事件等级、故障描述及起止时间戳）。**注意：虽然入口 URL 带有 `region=cn-shanghai`，但拦截底层全局事件接口或批量轮询核心 6 大国内 Region 参数，即可一次性拿到全国核心区状态，无需只局限于上海单区**。


3. **防假绿双重校验（极其关键！）**：
绝不能因为“没拦截到故障事件”就直接判定阿里云全绿（万一是页面加载白屏或被 WAF 滑块拦住了呢？）。代码必须执行**正向存活断言**：确认至少成功截获了非空的“云产品分类目录 JSON”（证明业务 API 正常返回了 200），且页面未出现 `baxia-dialog` / 验证码容器；若断言不通过，立即将该厂商标记为 `stale`（探测受阻）并保留上一轮快照。



### 3.4 百度智能云（`[https://cloud.baidu.com/status.html](https://cloud.baidu.com/status.html)`）

百度智能云健康看板结构非常直观清晰：页面直接汇总展示 **24 个核心云与 AI 产品大类**，并在顶部给出实时的三态数字看板（`正常`、`提示`、`异常`）及 `上次更新时间`，同时提供 `历史事件` 列表切换。

* **标准解析方案（Playwright XHR 拦截 + 顶栏计数器交叉验证）**：
1. **拦截数据源**：复用同一个 Playwright 实例打开 `[https://cloud.baidu.com/status.html](https://cloud.baidu.com/status.html)`（自动绕过百度云加速对海外脚本 TLS 指纹的拦截），截获页面拉取当前 24 项产品健康状态与历史事件的 JSON 响应。
2. **状态提取与交叉验证**：
* 从拦截到的 JSON（或页面渲染完成后的结构化状态区）提取三个顶层指标：`normalCount`（正常数，常态为 24）、`noticeCount`（提示数）、`abnormalCount`（异常数）以及具体的产品卡片状态（对应页面 `icon_normal`、`icon_info`、`icon_abnormal` 三种状态态）。
* 点击或触发 `历史事件` 数据请求，提取历史故障记录写入归档库；同时挂载 StatusGrid 的**合成事件引擎**，一旦某轮检测到某项产品（如云服务器 BCC 或千帆大模型平台）变为 `abnormal`，立即自动记录起止时间。


3. **状态归一化公式**：
* `abnormalCount` 大于等于 3 → `major_outage`
* `abnormalCount` 为 1 至 2 → `partial_outage`
* `abnormalCount` 为 0 且 `noticeCount` 大于 0 → `degraded`（若文案含“维护/升级”则归为 `maintenance`）
* `abnormalCount === 0 && noticeCount === 0 && normalCount > 0` → `operational`





---

## 四、 13 家厂商采集与资源开销全景速查表

在单次 GitHub Actions 定时任务中，将 **9 家纯 HTTP 接口并发执行** 与 **4 家共享单实例 Playwright 并发标签页** 结合，单轮全量采集可在 **12 至 18 秒** 内全部完成：

| 序号 | 厂商 ID | 采集通道类型 | 核心请求目标 | 原生支持历史 Case？ | 单次平均耗时 |
| --- | --- | --- | --- | --- | --- |
| 1 | `cloudflare` | 纯 HTTP (`undici`) | `[cloudflarestatus.com/api/v2/summary.json](https://cloudflarestatus.com/api/v2/summary.json)` | 原生支持 (`incidents.json`) | 0.4s |
| 2 | `github` | 纯 HTTP (`undici`) | `[githubstatus.com/api/v2/summary.json](https://githubstatus.com/api/v2/summary.json)` | 原生支持 (`incidents.json`) | 0.3s |
| 3 | `claude` | 纯 HTTP (`undici`) | `[status.claude.com/api/v2/summary.json](https://status.claude.com/api/v2/summary.json)` | 原生支持 (`incidents.json`) | 0.5s |
| 4 | `openai` | 纯 HTTP (`undici`) | `[status.openai.com/api/v2/summary.json](https://status.openai.com/api/v2/summary.json)` | 原生支持 (`incidents.json`) | 0.5s |
| 5 | `moonshot` | 纯 HTTP (`undici`) | `status.moonshot.cn/api/v2/summary.json` | 原生支持 (`incidents.json`) | 1.2s |
| 6 | `deepseek` | 纯 HTTP (`undici`) | `[status.deepseek.com/feed.atom](https://status.deepseek.com/feed.atom)` + SSR Flight / JSON | 原生支持 (`feed.atom`) | 1.0s |
| 7 | `gcp` | 纯 HTTP (`undici`) | `[status.cloud.google.com/incidents.json](https://status.cloud.google.com/incidents.json)` | 原生支持（含数年全量历史） | 0.6s |
| 8 | `apple-cn` | 纯 HTTP (`undici`) | `[apple.com/cn/.../system_status_zh_CN.js](https://apple.com/cn/.../system_status_zh_CN.js)` | 支持近期已恢复事件 + 合成归档 | 0.8s |
| 9 | `azure` | 纯 HTTP (`undici`) | `rssfeed.azure.status.microsoft/en-us/status/feed/` | 支持近期 RSS + 合成归档 | 0.9s |
| 10 | `aws-cn` | HTTP 优先 + 浏览器兜底 | `health.amazonaws.cn/public/currentevents` | 依赖合成事件引擎持久化归档 | 2.5s |
| 11 | `tencent-cloud` | 官方 TCHD API / 浏览器拦截 | `tchd.tencentcloudapi.com` (`DescribeEvents`) | 原生支持（按日期查历史） | 1.5s / 5s |
| 12 | `aliyun` | 共享 Playwright 拦截 | `[status.aliyun.com/#/?region=cn-shanghai](https://status.aliyun.com/#/?region=cn-shanghai)` XHR | 支持近期事件 + 合成事件归档 | 6.0s |
| 13 | `baidu-cloud` | 共享 Playwright 拦截 | `[cloud.baidu.com/status.html](https://cloud.baidu.com/status.html)` XHR + 状态计数器 | 原生历史事件列表 + 合成归档 | 5.0s |
