**StatusGrid（`grid.thetamind.ai`）** 定位为面向全球开发者、架构师与 SRE 团队的**云与 AI 基础设施全景状态矩阵与开放数据中枢**。本方案涵盖产品需求（PRD）、交互体验（UX）、视觉规范（UI）、高扩展系统架构、标准数据协议（JSON 与 RSS/Atom）及零服务器运维部署设计，可直接作为后续工程研发的完整蓝图。

---

## 一、 产品需求文档（PRD）

### 1.1 产品定位与核心价值主张

* **产品名称**：**StatusGrid**（隶属于 ThetaMind 生态，主域名 `grid.thetamind.ai`）
* **核心主张**：*One Grid to Watch Them All* —— 看全球主流云厂商与大模型服务的核心状态，来这一个矩阵就够了；查完汇总，一键直跳源站。
* **解决的核心痛点**：
1. **消除排障定界盲区（缩短 MTTI）**：现代业务普遍采用“多云 + 多模型 API + 全球 CDN”架构。线上告警突发时，SRE 无需在十几个官方状态页之间逐一刷新排查，打开 `grid.thetamind.ai` 即可在 5 秒内完成“内部故障 vs 上游基础设施故障”的定界。
2. **填补历史数据与订阅断层**：部分国内外厂商的状态页仅展示实时状态，缺乏直观的历史故障（Case）汇总，甚至不提供标准 RSS 或干净的 JSON 接口。StatusGrid 充当“状态转换器与历史档案馆”，将异构状态统一转化为标准开放数据流。



### 1.2 目标用户画像与核心场景

| 用户角色 | 典型使用场景 | 核心诉求 |
| --- | --- | --- |
| **SRE / 运维工程师** | 凌晨收到业务接口超时告警，手机或电脑打开 StatusGrid 排查上游依赖；将 StatusGrid 的开放 JSON 接入公司告警系统做“上游故障自动抑制”。 | 首屏秒开、异常置顶、准确的时间戳、稳定的 JSON API 与 RSS 订阅流。 |
| **AI 应用开发者** | 调用大模型接口出现高延迟或 `502` 报错，快速对比 OpenAI、Claude、DeepSeek、Moonshot 当前健康度，决定是否切换备用模型路由。 | 按“AI 大模型”分类秒级过滤、细粒度区分“API 状态”与“网页端对话状态”。 |
| **技术负责人 / 架构师** | 季度技术选型或外部供应商 SLA 评估时，回溯过去 90 天各家云厂商与模型厂的宕机频次、恢复时长（MTTR）及官方复盘报告（Postmortem）。 | 跨厂商历史 Case 检索、故障持续时长统计、一键直达官方复盘原文。 |

### 1.3 功能范围与演进路线图

| 优先级 | 模块 | 功能点描述 |
| --- | --- | --- |
| **P0 (MVP 必选)** | **全局态势总览** | 顶部全局健康度状态灯、当前活跃故障总数统计、最近一次探测同步时间及倒计时、一键手动刷新本地缓存数据。 |
| **P0 (MVP 必选)** | **全景状态矩阵 (Grid)** | 首批 13 家云与 AI 厂商状态卡片展示；异常厂商自动置顶；卡片提供一键直跳官方状态页外链按钮；展示近 30 天每日健康度热力条。 |
| **P0 (MVP 必选)** | **分厂商精细查询** | 按分类（AI / 全球云 / 国内云 / 基础设施）、按状态（仅看异常）筛选；支持穿透式搜索（搜厂商名、搜子服务如 `ECS` / `API`、搜地域如 `Shanghai`）；点击卡片展开抽屉查看子服务组件状态。 |
| **P0 (MVP 必选)** | **历史 Case 回溯库** | 独立的时间轴视图，支持按时间范围、厂商、严重等级筛选历史故障事件，自动计算故障持续时长，保留事件演化记录及官方源链接。 |
| **P0 (MVP 必选)** | **开放数据中心** | 静态预生成统一格式的对外 JSON API（全局摘要 + 单厂商详情 + 月度历史归档）与标准 RSS 2.0 / Atom 1.0 订阅源。 |
| **P1 (体验增强)** | **定制化大屏与收藏** | 支持通过浏览器本地存储“置顶关注（Pin）”核心依赖厂商；所有过滤条件实时同步至 URL 参数，方便团队将定制视图保存为群公告书签；支持 TV 监控大屏全屏纯净模式（Kiosk Mode）。 |
| **P2 (生态开放)** | **开源共建与状态徽章** | 提供声明式厂商配置文件规范，支持外部开发者通过提交 GitHub PR 用数行配置接入新站点；生成 SVG 动态状态徽章供内网 Wiki 嵌入。 |

### 1.4 非功能性需求（SRE 级质量红线）

* **诚实性原则（绝不误报平安）**：当某个厂商源站因网络抖动或改版导致抓取失败时，前端严禁沿用旧状态伪装成“正常（Operational）”，必须明确切换为 `探测受阻 / 数据陈旧（Stale）` 视觉态，提示上次成功时间并引导用户点击直跳源站。
* **故障隔离性**：单厂商采集超时或解析报错必须被严格沙箱隔离，绝不影响同批次其余厂商的状态更新与发布。
* **性能指标**：全站零后端运行时依赖；首屏核心数据包 Gzip 压缩后体积控制在 40KB 以内，桌面与移动端首屏渲染（LCP）控制在 1 秒以内。

---

## 二、 交互设计规范（UX Design）

### 2.1 整体信息架构（IA）

全站采用 **“单页应用外壳 + 双核心工作区切换 + 右侧详情抽屉”** 的零跳转架构，确保排障心流不被页面刷新打断。

```text
StatusGrid (grid.thetamind.ai)
├── 顶部导航栏 (Header)
│   ├── 品牌标识：StatusGrid by ThetaMind
│   ├── 核心视图切换器：[ 实时矩阵 Live Grid ]  |  [ 历史故障库 Incident Vault ]
│   └── 工具区：开放数据订阅入口 (API / RSS 弹窗) | 大屏全屏模式开关 | 深浅主题切换 | GitHub 源码入口
│
├── 全局态势横幅 (Global Hero Banner)
│   ├── 全局定性结论（如："All 13 Monitored Providers Operational" 或 "2 Providers Experiencing Issues"）
│   └── 数据新鲜度徽章（上次同步于 6 分钟前 · 预计 14 分钟后下次更新 · 采集引擎健康度指示）
│
├── 粘性控制与检索栏 (Sticky Filter & Search Bar)
│   ├── 穿透式搜索框（支持快捷键 "/" 唤醒，检索厂商 / 子组件 / 地域 / 故障关键词）
│   ├── 分类胶囊过滤：全部 (13) | AI 大模型 (4) | 国内云 (4) | 全球云与基建 (5) | ★ 我的关注
│   └── 快速开关：[ 仅看异常 ] 切换按钮
│
├── 主工作区一：实时矩阵视图 (Live Grid View)
│   ├── 活跃异常置顶区 (Active Alerts Zone) —— 仅当存在非正常厂商时动态渲染，高优先级大卡片展示
│   └── 全景状态网格区 (Standard Status Grid) —— 按关注度/分类排列的标准厂商卡片
│
├── 主工作区二：历史故障回溯视图 (Incident Vault View)
│   ├── 多维筛选栏：时间跨度（近 7 天 / 30 天 / 90 天 / 月度归档选择） + 厂商多选 + 故障等级多选
│   ├── 统计概览微卡片：所选周期内累计记录事件数、平均恢复时长 (MTTR)、波及范围最广厂商
│   └── 按日期分组的事件时间轴列表（支持原地展开完整事件进展日志与直达官方 Postmortem）
│
└── 右侧滑出详情抽屉 (Provider Detail Drawer - 点击任意厂商卡片触发)
    ├── 抽屉头部：厂商 Logo + 名称 + 当前总状态 + 醒目的【前往官方状态页 ↗】主按钮
    ├── 活跃事件看板：当前未恢复故障的完整调查进度（Investigating → Identified → Monitoring）
    ├── 核心子服务组件树：按业务线折叠/展开（如 OpenAI 下的 API / ChatGPT / Sora；阿里云下的计算 / 网络 / 存储）
    ├── 该厂商近 30 天历史 Case 速览
    └── 开发者接入区：一键复制该厂商专属 JSON API 地址与独立 RSS 订阅链接

```

### 2.2 四大关键交互体验细节

1. **异常自动冒泡与置顶机制（Auto-Bubbling）**
平时所有厂商正常时，矩阵按“用户置顶优先 → 预设权重序”安静排列；一旦某家厂商进入降级、局部中断或严重宕机状态，该卡片自动上浮至页面最顶部的 **“当前异常（Active Incidents）”** 独立高亮区块，并直接在卡片表面透出受影响的具体子组件与故障摘要，省去点击下钻步骤。
2. **双通道“一键跳转源站”设计**
* **卡片级直跳**：每张厂商卡片右上角固定设有独立热区的跳转按钮（带外链箭头图标及悬停提示 `打开 OpenAI 官方状态页`），点击直接新标签页打开源站，不触发内部抽屉。
* **事件级深链（Deep-Link）直跳**：若厂商存在具体的活跃故障或历史 Case，标题旁附带直达该条官方故障详情页（如 `[status.openai.com/incidents/xyz](https://status.openai.com/incidents/xyz)`）的精确链接，方便 SRE 直接复制官方链接发至公司应急响应群。


3. **云厂商“多地域 × 多产品”降噪交互**
针对阿里云、腾讯云、AWS、GCP、Azure 这类拥有数十个地域（Region）和上百个云产品的巨头，严禁将几千个状态格平铺到页面。卡片默认展示按核心产品大类（计算、存储、数据库、网络、AI 服务）聚合后的状态；只有当某个具体地域（如 `华东2-上海`）发生异常时，才在卡片和抽屉中动态弹出受影响地域标签（如 `ECS [cn-shanghai: 性能降级]`），做到“平时极简，战时精准”。
4. **URL 状态全量双向绑定**
用户在界面上的任何分类切换、搜索输入、抽屉展开（如 `?cat=ai&only_abnormal=1&provider=deepseek`）均通过无刷新路由同步至浏览器地址栏。团队成员复制当前 URL 发给同事，对方打开看到的是完全一致的过滤现场。

---

## 三、 视觉设计规范（UI Design System）

### 3.1 视觉基调：极客暗黑指挥舱（Dark-First Command Center）

借鉴 Linear、Vercel 与航空仪表盘的工业设计美学：**去装饰化、高对比度边框分割、克制的色彩使用**。背景与容器采用深冷灰阶，将全站唯一的鲜艳高饱和色彩完全留给“健康度状态信号”，让异常状态在视野中具备毫秒级的视觉捕获力。

### 3.2 六级标准语义色彩与微动效体系

为兼顾色觉障碍用户与远距离大屏观看，每一种状态必须同时绑定 **专属色值 + 独立几何图标 + 差异化微动效**，绝不仅凭颜色区分：

| 标准状态枚举 | 中文定义 | 深色模式主色 | 浅色模式主色 | 图标与微交互视觉规范 |
| --- | --- | --- | --- | --- |
| `operational` | 运行正常 | `#10B981` (翡翠绿) | `#059669` | 静态实心圆点；卡片采用默认低对比度暗色边框，视觉充分降噪。 |
| `maintenance` | 计划内维护 | `#3B82F6` (天际蓝) | `#2563EB` | 扳手/时钟线性图标；蓝色胶囊标签，明确区分于意外故障。 |
| `degraded` | 性能降级 / 高延迟 | `#F59E0B` (琥珀黄) | `#D97706` | 警告三角图标；卡片顶部渲染 2px 琥珀色高亮修饰线。 |
| `partial_outage` | 局部服务中断 | `#F97316` (警示橙) | `#EA580C` | 半实心圆裂纹图标；卡片背景叠加 5% 透明度橙色渐变微光。 |
| `major_outage` | 严重宕机 / 全线中断 | `#EF4444` (绯红) | `#DC2626` | 感叹号八角图标 + **双层呼吸脉冲扩散动画（Ping）**；高对比度红色警示边框。 |
| `stale` | 探测受阻 / 数据过期 | `#64748B` (岩板灰) | `#475569` | 虚线圆环加问号图标；卡片呈半透明暗淡态，提示源站抓取超时。 |

### 3.3 字体与排版栅格规范

* **字体组合**：界面文本使用现代无衬线字体（`Inter` / `Geist Sans` / 系统原生苹方与微软雅黑）；所有时间戳、倒计时、持续时长（如 `01h 35m`）、可用率数字及 API 路径强制使用等宽编程字体（`JetBrains Mono`），确保多行数字纵向绝对对齐。
* **响应式网格断点**：
* **超宽监控大屏（1920px 及以上）**：4 列宽幅矩阵，开启 Kiosk 全屏模式后隐藏页脚与说明文案，适合挂在运维值班室电视墙。
* **标准桌面端（1280px 至 1919px）**：3 列黄金比例网格，间距 `16px`。
* **平板端（768px 至 1279px）**：2 列网格。
* **手机端（768px 以下）**：单列高密度卡片流，右侧详情抽屉自动转化为底部上滑半屏面板（Bottom Sheet），单手大拇指即可完成检索与源站跳转。



### 3.4 厂商状态卡片视觉结构图（Card Wireframe）

```text
+-----------------------------------------------------------------------+
| [Logo]  OpenAI                            [AI]        [ ↗ 源站直达 ]  |
|         status.openai.com                                             |
|-----------------------------------------------------------------------|
| ● 部分性能降级 (Degraded Performance)          更新于 6m 前 (19:00)   |
|                                                                       |
| 30日健康轨迹 (左旧 → 右新，每格代表1天，悬停显示当日故障数与时长):    |
| ██████████████████████▒██████▓   99.4% 无故障天数                     |
|                                                                       |
| +-------------------------------------------------------------------+ |
| | ▲ 活跃事件：API Elevated Error Rates on GPT-4o       [官方详情 ↗] | |
| |   已持续 42m · 受影响组件：API (Degraded), ChatGPT (Operational)  | |
| +-------------------------------------------------------------------+ |
+-----------------------------------------------------------------------+
  注：若无活跃事件，底部区块收敛为一行浅灰小字："共监控 6 项核心子服务 · 全部正常"

```

---

## 四、 系统架构与高可扩展性设计（System Architecture）

### 4.1 全局零服务器流水线架构图

```text
[ 上游 13+ 云与 AI 官方状态源 ]
  ├── 标准 Statuspage API (OpenAI / Claude / DeepSeek / Moonshot / GitHub / Cloudflare)
  ├── 官方公开 JSON / RSS 源 (Google Cloud / Apple CN / Azure)
  └── 复杂 SPA / 专有接口源 (阿里云 / 腾讯云 / 百度智能云 / AWS 中国)
                 │
                 ▼ (每 20 分钟定时触发 GitHub Actions Runner)
+-----------------------------------------------------------------------------------+
|                        Node.js 核心采集与编译引擎 (Collector Engine)              |
|                                                                                   |
|  1. 读取声明式注册表 (providers.yaml)  ──→ 动态分发至对应适配器实例               |
|  2. 并发执行池 (超时熔断 + 指数退避重试 + 按需启动共享无头浏览器拦截器)           |
|  3. 归一化清洗器 (异构字段映射为统一 6 级状态模型 + 多地域组件聚合降噪)           |
|  4. 状态比对与合成事件引擎 (对比 data 分支上次快照 → 自动生成/闭合历史 Incident)  |
|  5. 多格式静态产物生成器 (输出分片 JSON API v1 + 全局与分厂商 RSS/Atom XML)       |
+-----------------------------------------------------------------------------------+
                 │
         ┌───────┴───────────────────────────────┐
         ▼ (持久化归档)                          ▼ (静态合并发布)
[ Git 独立分支: data ]                  [ Git 独立分支: gh-pages ]
  ├── state/latest.json (热状态快照)      ├── 前端静态应用外壳 (预编译复用，免重复构建)
  ├── rollup/daily-30d.json (热力条统计)  ├── /api/v1/* (对外开放静态 RESTful JSON)
  └── incidents/2026-11.json (月度冷分片) └── /feed/* (全局、分类、单厂商 RSS/Atom)
                                                 │
                                                 ▼ (GitHub Pages 全球边缘 CDN)
                                     [ https://grid.thetamind.ai ]
                                    ↙              ↓              ↘
                           浏览器可视化大屏    RSS 群聊机器人    外部监控系统轮询

```

### 4.2 高可扩展插件架构（未来如何极低成本接入第 14、第 50 个站点？）

为了彻底避免“每加一个厂商就要改一遍核心代码和前端组件”的泥潭，系统采用 **“声明式厂商注册表 + 三层适配器池”** 架构。**前端完全由数据驱动，新增厂商无需修改任何一行前端代码**。

#### 第一层：零代码通用协议适配器（覆盖市面上约 75% 的科技与 AI 站点）

系统内置五大标准状态页协议解析器。未来接入属于以下生态的站点（如 Vercel、Stripe、Groq、HuggingFace、Cohere、Notion、Docker、Supabase 等），**只需在配置文件中增加几行声明即可自动生效**：

1. **`atlassian-statuspage` 通用适配器**：自动请求目标站点下的 `/api/v2/summary.json` 与 `/api/v2/incidents.json`，原生提取全量组件、活跃事件与历史复盘。
2. **`incident-io` 通用适配器**：兼容新一代 AI 厂商广泛迁移使用的 Incident.io 状态页结构（含其兼容的 summary 接口与专属 RSS/Widget 数据流）。
3. **`google-cloud-json` 通用适配器**：兼容采用 `incidents.json` + `products.json` 模式的 Google 系基础设施（GCP、Google Workspace、Firebase）。
4. **`instatus-betterstack` 通用适配器**：兼容开源与新兴 SaaS 状态页标准接口。
5. **`generic-rss-atom` 通用适配器**：只要目标厂商提供故障通知 RSS/Atom，即可通过关键词规则自动解析出当前状态与历史时间线。

#### 第二层：轻量级自定义接口适配器（针对自研 JSON / JSONP 接口站点）

针对 Apple、阿里云等拥有自研后端 JSON 数据源的厂商，定义严格的“单一职责解析器插件契约”：每个自定义厂商对应 `adapters/custom/{provider_id}.ts` 一个独立文件，只负责将源站原始响应翻译为内部标准结构，重试、并发控制、超时熔断、历史归档全部由底层框架托管。

#### 第三层：无头浏览器网络拦截兜底引擎（针对重度前端加密 / 国内云 SPA）

针对部分带有动态前端签名、直接请求接口会被 WAF 拦截或纯前端渲染的国内云站点，内置**按需唤醒的 Playwright 共享浏览器上下文池**：

* **优先采用“网络响应拦截（Network Interception）”而非脆弱的 DOM 抠取**：无头浏览器打开官方状态页，直接在底层截获页面自身 JavaScript 发起并成功返回的 XHR JSON 数据包。这种方式比写 CSS 选择器解析页面标签稳定数倍，哪怕对方微调了前端样式也不会失效。
* **按需冷启动**：仅当配置中存在标记为 `browser-intercept` 的厂商时才拉起浏览器实例，且多个国内云站点复用同一个浏览器进程并发打开独立标签页，将采集总耗时控制在 15 秒以内。

### 4.3 首批 13 家目标站点接入策略与适配器映射全表

| 厂商标识 (`id`) | 厂商名称 | 分类 | 源站特征分析 | 选定适配器类型 | 采集与数据清洗关键设计要点 |
| --- | --- | --- | --- | --- | --- |
| `deepseek` | DeepSeek | AI | 标准 Statuspage 体系 | 通用 `statuspage-v2` | 直接拉取 `summary.json` 与 `incidents.json`，区分 API 服务与网页对话端组件。 |
| `openai` | OpenAI | AI | Incident.io 驱动（保留兼容接口与源流） | 通用 `incident-io` / `statuspage-v2` | 重点拆分 API、ChatGPT、Sora、Playground 四大核心组件群，保留详细事件更新流。 |
| `claude` | Anthropic Claude | AI | 标准 Statuspage 体系 | 通用 `statuspage-v2` | 区分 `claude.ai`、`console` 与 `api.anthropic.com` 状态，精准服务开发者定界。 |
| `moonshot` | Moonshot (Kimi) | AI | 标准 Statuspage / 兼容 JSON 体系 | 通用 `statuspage-v2` | 提取 Kimi 开放平台 API 与 C 端助手组件状态，处理中文事件标题编码。 |
| `cloudflare` | Cloudflare | 基建 | 标准 Statuspage（组件数量极多，含全球数百节点） | 通用 `statuspage-v2`（开启组件过滤） | **关键防膨胀处理**：Cloudflare 包含数百个边缘机场节点组件，必须配置聚合规则，仅保留 CDN/DNS/Workers/Zero Trust 核心产品线，边缘节点仅在非正常时透出。 |
| `github` | GitHub | 基建 | 标准 Statuspage 体系 | 通用 `statuspage-v2` | 核心监控 Git Operations、Actions、Pages、API Requests、Copilot 五大核心项。 |
| `gcp` | Google Cloud | 全球云 | 公开提供 `products.json` 与全量 `incidents.json` | 通用 `google-cloud-json` | 通过活跃事件的 `end` 字段是否为空判定当前状态，自动关联受影响的产品名与 Region。 |
| `azure` | Microsoft Azure | 全球云 | 多地域矩阵庞大，提供官方全球状态 RSS 与区域状态接口 | 自定义 `azure-status` | 结合官方状态 RSS 流与页面内置 JSON 状态负载，按 Compute / Networking / AI Foundry 大类聚合。 |
| `apple-cn` | Apple 系统状态 | 基建 | 异步加载 `system_status` JSONP 脚本文件 | 自定义 `apple-jsonp` | 剥离外层 JSONP 回调函数壳即可获得极干净的纯中文服务列表与当前活跃 `events` 数组。 |
| `aliyun` | 阿里云 | 国内云 | SPA 单页应用，后端按 Region 与产品线通过 XHR JSON 接口返回事件 | 自定义 `aliyun-xhr`（浏览器拦截兜底） | 默认聚焦国内核心大区（杭州、上海、北京、深圳、张家口、香港）及全局服务，聚合为计算、存储、网络、数据库、百炼大模型五大组件组。 |
| `tencent-cloud` | 腾讯云 | 国内云 | SPA 健康看板，XHR 接口返回各地域产品状态与公告 | 自定义 `tencent-xhr`（浏览器拦截兜底） | 提取当前未恢复故障事件及受影响地域，配置跨境请求超时放宽至 15 秒并带 2 次重试。 |
| `baidu-cloud` | 百度智能云 | 国内云 | 静态与动态混合渲染状态页 | 自定义 `baidu-cloud`（浏览器兜底） | 提取各核心云产品线与千帆大模型平台运行状态，启用“合成事件引擎”补齐其历史记录。 |
| `aws-cn` | AWS 中国区 | 国内云 | 独立于全球 AWS，覆盖北京（光环新网）与宁夏（西云数据）双区域 | 自定义 `aws-cn-health`（浏览器拦截兜底） | 拦截 AWS Health Dashboard 中国区后端状态与事件列表接口，按北京区、宁夏区两大根组件归类展示。 |

### 4.4 核心机制：合成事件生成引擎（让没有历史记录的源站也拥有历史库）

部分国内厂商状态页只展示“此刻绿灯或红灯”，一旦故障恢复，页面上不留任何历史痕迹。StatusGrid 在采集层设计了 **状态机比对与合成事件（Synthetic Incident）机制**：

1. **故障捕获**：每轮采集完成后，引擎将当前各厂商状态与 `data` 分支保存的上一次快照（`latest.json`）逐一比对。若某厂商自身未返回结构化事件列表，但其总状态或子组件状态由 `operational` 恶化为异常态，引擎自动为其创建一条带有唯一指纹的合成事件（标记 `isSynthetic: true`，记录首次发现时间 `startedAt`）。
2. **状态演进记录**：故障持续期间，若受影响组件范围扩大或严重度升级，自动向该事件的日志数组追加一条状态变更节点。
3. **自动归档闭合**：当后续某次轮询检测到该厂商恢复为 `operational` 时，引擎自动填入恢复时间 `resolvedAt`，计算出累计影响时长，并将该完整 Case 永久写入当月历史归档库。

### 4.5 统一对外数据服务设计（Open Data API & RSS/Atom）

StatusGrid 通过构建期静态文件生成技术，零服务器成本对外提供一套高性能、允许跨域调用（GitHub Pages 原生支持 `Access-Control-Allow-Origin: *`）的标准数据接口：

| 接口路径 | 格式 | 更新策略与体积目标 | 面向下游消费场景 |
| --- | --- | --- | --- |
| `/api/v1/summary.json` | JSON | 每 20 分钟更新；小于 40KB | StatusGrid 首屏加载；企业内部 Prometheus / Zabbix / 巡检脚本高频拉取做告警抑制。 |
| `/api/v1/providers/{id}.json` | JSON | 每 20 分钟更新；按厂商拆分 | 前端点击某厂商抽屉时按需懒加载（保证未来扩展至 100 家厂商首屏依然飞快）；单厂商定向监控。 |
| `/api/v1/incidents/recent.json` | JSON | 每 20 分钟更新；保留近 30 天全网事件 | 历史故障库首屏默认数据源；外部数据分析大盘读取。 |
| `/api/v1/incidents/archive/{YYYY-MM}.json` | JSON | 当月动态追加，跨月永久冻结只读 | 用户在历史故障库切换查看往月/往年历史 Case 时按需加载，永不拖慢日常读写。 |
| `/api/v1/meta/health.json` | JSON | 每 20 分钟更新；小于 5KB | 暴露采集器自身运行指标（上次执行耗时、13 家站点各自 HTTP 耗时与成功状态）。 |
| `/feed/all.xml` 与 `/feed/atom.xml` | RSS 2.0 / Atom | 仅在事件触发、升级、恢复时变更条目 | 飞书、钉钉、企微、Slack 群聊 RSS 机器人订阅全网故障通报。 |
| `/feed/category/{cat}.xml` | RSS 2.0 | 按 `ai`、`cloud-cn`、`cloud-global`、`infra` 拆分 | 业务研发团队精准订阅（如算法团队仅订阅 `/feed/category/ai.xml`）。 |
| `/feed/provider/{id}.xml` | RSS 2.0 | 为每一家接入厂商单独生成标准 RSS | **杀手级特性**：帮原本不提供 RSS 的国内云或大模型厂免费赋能标准 RSS 订阅能力。 |

---

## 五、 数据结构与存储协议设计（Data Schema Design）

### 5.1 声明式厂商注册表结构（`registry/providers.json` 规范示例）

新增厂商时仅需在此注册表追加一个配置对象：

```json
{
  "id": "deepseek",
  "name": "DeepSeek",
  "category": "ai",
  "tags": ["LLM", "China", "API"],
  "officialStatusUrl": "https://status.deepseek.com/",
  "officialHomeUrl": "https://www.deepseek.com/",
  "adapter": {
    "type": "statuspage-v2",
    "endpoint": "https://status.deepseek.com/api/v2",
    "timeoutMs": 10000,
    "retries": 2,
    "componentFilter": {
      "mode": "include_all",
      "ignorePatterns": ["Deprecated"]
    }
  },
  "displayOrder": 10,
  "enabled": true
}

```

### 5.2 全局轻量汇总快照协议（`/api/v1/summary.json`）

为极致压缩首屏与外部 API 调用体积，30 天每日健康轨迹采用 30 位定长字符编码（`0`=正常，`1`=维护，`2`=降级，`3`=局部中断，`4`=严重宕机，`9`=无数据）：

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "2026-11-25T11:20:00Z",
  "intervalMinutes": 20,
  "globalSummary": {
    "overallStatus": "degraded",
    "totalProviders": 13,
    "countsByStatus": {
      "operational": 11,
      "maintenance": 0,
      "degraded": 1,
      "partial_outage": 0,
      "major_outage": 0,
      "stale": 1
    },
    "activeIncidentCount": 1
  },
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "category": "ai",
      "status": "degraded",
      "officialStatusUrl": "https://status.openai.com/",
      "lastSuccessAt": "2026-11-25T11:19:52Z",
      "lastCheckedAt": "2026-11-25T11:19:52Z",
      "componentSummary": {
        "total": 5,
        "abnormal": 1,
        "abnormalNames": ["API"]
      },
      "dailyTrack30d": "000000000000002000000003000002",
      "activeIncidents": [
        {
          "id": "openai_inc_01JDF89X",
          "title": "Elevated error rates on Chat Completions API",
          "severity": "degraded",
          "startedAt": "2026-11-25T10:38:00Z",
          "updatedAt": "2026-11-25T11:10:00Z",
          "sourceUrl": "https://status.openai.com/incidents/01JDF89X"
        }
      ]
    }
  ]
}

```

### 5.3 单厂商详情与标准历史事件模型（`/api/v1/providers/{id}.json` 与月度归档通用）

```json
{
  "schemaVersion": "1.0",
  "provider": {
    "id": "openai",
    "name": "OpenAI",
    "category": "ai",
    "status": "degraded",
    "officialStatusUrl": "https://status.openai.com/",
    "updatedAt": "2026-11-25T11:20:00Z"
  },
  "componentGroups": [
    {
      "groupName": "Core Services",
      "components": [
        { "id": "comp_api", "name": "API", "status": "degraded", "region": "global" },
        { "id": "comp_chatgpt", "name": "ChatGPT", "status": "operational", "region": "global" },
        { "id": "comp_sora", "name": "Sora", "status": "operational", "region": "global" }
      ]
    }
  ],
  "dailyHistory30d": [
    {
      "date": "2026-11-25",
      "worstStatus": "degraded",
      "incidentCount": 1,
      "downtimeMinutes": 42
    }
  ],
  "recentIncidents": [
    {
      "id": "openai_inc_01JDF89X",
      "upstreamId": "01JDF89X",
      "providerId": "openai",
      "providerName": "OpenAI",
      "title": "Elevated error rates on Chat Completions API",
      "severity": "degraded",
      "state": "monitoring",
      "isSynthetic": false,
      "affectedComponents": ["API"],
      "affectedRegions": ["global"],
      "startedAt": "2026-11-25T10:38:00Z",
      "resolvedAt": null,
      "durationMinutes": null,
      "sourceUrl": "https://status.openai.com/incidents/01JDF89X",
      "postmortemUrl": null,
      "updates": [
        {
          "phase": "monitoring",
          "body": "A fix has been implemented and we are monitoring the results.",
          "timestamp": "2026-11-25T11:10:00Z"
        },
        {
          "phase": "investigating",
          "body": "We are currently investigating elevated error rates on API requests.",
          "timestamp": "2026-11-25T10:38:00Z"
        }
      ]
    }
  ]
}

```

### 5.4 `data` 分支时间分片存储目录树（运行 10 年不膨胀设计）

如果将所有历史记录塞进单一 JSON 文件，一年后文件体积将急剧膨胀，拖慢每次流水线读写。`data` 分支采用 **冷热分离 + 月度分片（Monthly Sharding）** 目录结构：

```text
Branch: data
├── state/
│   ├── latest.json              # 上一轮全量热状态快照（供下一轮比对差异与合成事件使用）
│   └── collector-health.json    # 各站点连续成功/失败计数器（用于触发连续失败告警）
├── providers/
│   ├── openai.json              # 各厂商最新全量详情快照
│   ├── aliyun.json
│   └── ...
├── rollup/
│   └── daily-stats-90d.json     # 滚动保留最近 90 天的日级健康度汇总矩阵（自动淘汰 90 天前记录）
└── incidents/
    ├── recent-30d.json          # 滑动窗口：近 30 天跨厂商活跃与已恢复事件热表
    └── archive/
        ├── index.json           # 历史归档月份索引列表（如 ["2026-11", "2026-10"]）
        ├── 2026-10.json         # 已跨月冻结的冷数据分片（采集任务平时完全无需读取它）
        └── 2026-11.json         # 当月活跃归档分片（采集任务每轮仅增量更新此单一文件）

```

### 5.5 RSS / Atom 订阅条目格式规范

为确保群聊机器人（飞书/钉钉/Slack）直接转发 RSS 时具备极高可读性，对订阅源字段做如下强约束：

* **标题结构化前缀**：强制携带状态标签与厂商名。
* 新故障触发：`[故障告警 | DEGRADED] OpenAI - Elevated error rates on API`
* 故障已恢复：`[故障恢复 | RESOLVED] OpenAI - Elevated error rates on API (历时 1h 12m)`


* **防刷屏幂等策略**：利用故障唯一 ID 加生命周期阶段作为条目标识（如 `openai_inc_01JDF89X#triggered` 与 `openai_inc_01JDF89X#resolved`），仅在“故障首次确认/严重度升级”**和**“故障最终恢复”两个关键里程碑向 RSS 推送新条目，中间琐碎的排查文案更新不重复轰炸用户群聊。
* **双链接附带**：正文底部同时提供 `[在 StatusGrid 查看全网关联态势]` 与 `[直达 OpenAI 官方故障原贴]` 两个超链接。

---

## 六、 部署、域名与自身高可用设计（Deployment & Self-SRE）

### 6.1 三分支彻底解耦与 Git 体积零膨胀方案

| 分支名称 | 存放内容 | 提交与防膨胀策略 |
| --- | --- | --- |
| **`main`** | 采集引擎源码、前端 React 源码、厂商注册表配置、GitHub Actions 工作流文件。 | 正常保留完整 Git 提交历史，仅在人工修改功能或新增厂商配置时变更。 |
| **`data`** | 纯 JSON 结构化状态快照与按月分片的历史 Case 归档库。 | **单快照覆写提交（Amend / Orphan Commit）**：每次采集任务仅浅克隆（`fetch-depth: 1`）拉取最新状态，合并写入后以孤儿单节点覆写推送到远端。既完整保留了 `incidents/archive/*.json` 里跨越多年的业务历史文件，又让 `.git` 底层对象库体积永远维持在数 MB 以内！ |
| **`gh-pages`** | 编译好的前端静态资源、`CNAME` 域名文件、生成的 `/api/v1/*` 与 `/feed/*` 静态文件。 | 每次部署采用全新孤儿分支覆盖发布，不保留构建产物的冗余 Git 历史。 |

### 6.2 双工作流分离（极致压缩每次定时运行耗时）

不要在每 20 分钟一次的数据抓取任务里重复编译前端工程！将 GitHub Actions 拆分为两条职责分明的流水线：

1. **工作流 A：`Build Frontend Shell`（仅在 `main` 分支前端代码有改动时触发）**
* 编译前端静态应用外壳（HTML / CSS / JS），打包为构建产物（Artifact）或提交至静态模板区备用。


2. **工作流 B：`Sync Status & Publish`（每 20 分钟定时触发 + 支持手动按钮触发）**
* **不运行前端打包编译**！直接拉取 `data` 分支 → 运行 Node.js 采集器（约 15 秒） → 更新 `data` 分支 → 将最新生成的 `/api/v1/*` 和 `/feed/*` 直接注入预编译好的前端静态目录 → 推送至 `gh-pages`。
* **收益**：单次定时任务总耗时从传统的 2~3 分钟大幅压缩至 **20~30 秒**，极其轻量稳定。



### 6.3 域名解析与 CDN 缓存一致性设计（`grid.thetamind.ai`）

1. **DNS 与 HTTPS**：在 `thetamind.ai` 的 DNS 服务商处添加一条 `CNAME` 记录，主机记录为 `grid`，指向对应的 `<username-or-org>.github.io`；在项目静态根目录内置包含 `grid.thetamind.ai` 的 `CNAME` 文件，并在仓库 Pages 设置中开启强制 HTTPS（Enforce HTTPS）。
2. **应对 GitHub Pages 边缘缓存（10 分钟 TTL）**：
* GitHub Pages 底层 Fastly CDN 默认缓存静态文件 10 分钟，这与我们 20 分钟的采集周期天然契合，能帮我们扛住突发大流量（比如某大厂宕机时成千上万开发者同时涌入 `grid.thetamind.ai`）。
* 前端界面右上角的“手动刷新”按钮在用户主动点击时，仅对轻量级 `/api/v1/summary.json` 附加当前分钟级时间窗口参数，既保证排障人员能拉到最新边缘文件，又避免随机时间戳引发恶意缓存穿透。



### 6.4 “监控者自身的自愈与防失联设计”（Self-Observability）

作为 SRE 打造的基础设施工具，必须防备采集流水线自身静默挂掉的极端场景：

1. **规避 GitHub 60 天无提交自动停用定时任务陷阱**：
GitHub 官方规则规定，若公开仓库 `main` 分支连续 60 天没有任何提交，会自动挂起所有 `schedule` 定时工作流！设计一个每月 1 号凌晨运行的轻量级 `Monthly Keepalive & Archive` 任务，自动通过 GitHub API 检查工作流启用状态并刷新活跃度，确保无人值守也能长年稳定运行。
2. **前端“死人开关（Dead Man's Switch）”离线预警**：
前端页面不盲目相信静态 JSON，加载后立即计算 `当前客户端时间 - summary.generatedAt`。一旦差值超过 **60 分钟**（意味着后台 GitHub Actions 已连续漏跑 3 个周期），页面顶部全局横幅自动切换为醒目的琥珀色离线警示态：*“注意：状态采集流水线延迟，当前展示为 X 小时前的快照，请点击各厂商卡片右上角直跳官方源站核实”*。
3. **适配器失效自动提单告警（Auto-Issue Ops）**：
当某家云厂商改版网页或更换接口，导致对应适配器连续 **3 次（即持续 1 小时）** 采集失败时，采集引擎自动调用仓库自带的 `GITHUB_TOKEN` 在本仓库创建（并按厂商 ID 去重，绝不重复建单）一个带有 `adapter-broken` 标签的 GitHub Issue，GitHub 会立即向你的绑定邮箱发送告警邮件；一旦后续某次采集自动恢复成功，引擎自动追加评论并关闭该 Issue，实现零外部依赖的全自动闭环运维。
