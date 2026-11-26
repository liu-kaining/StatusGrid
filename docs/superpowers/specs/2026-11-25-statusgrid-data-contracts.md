# StatusGrid 数据契约 v1 设计

日期：2026-11-25  
状态：用户已确认设计；下列 TypeScript 是协议约束，正在按完整开发计划实施。

配套文档：[总体设计](2026-11-25-statusgrid-design.md)、[开发计划](../plans/2026-11-25-statusgrid-implementation.md)。

## 1. 通用规则

- 时间统一为 ISO 8601 UTC 字符串，输出使用 `Z`；日分片以 UTC 日历划分。
- 未知值使用 `null`，列表使用数组；不能用 `0`、空字符串或当前时间替代未知事实。
- `schemaVersion` 初始为 `"1.0"`；兼容新增字段不升大版本，字段删除或语义变化使用 `/api/v2/`。
- `snapshotId` 为本次采集的唯一字符串，例如 `20261125T114000Z-<runId>`；同一次运行重试发布复用该 ID。
- 稳定实体 ID 不依赖显示名称或数组顺序。上游 ID 更换时，通过明确别名迁移，不能静默合并不相关实体。
- 每个 URL 只允许 `https:`，站内链接可用明确的相对路径；禁止将上游任意协议直接放入可点击链接。

## 2. 状态与采集结果

```typescript
type Category = 'ai' | 'cloud-cn' | 'cloud-global' | 'infra';

type ServiceStatus =
  | 'operational'
  | 'maintenance'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage';

type PublicStatus = ServiceStatus | 'stale';
type Freshness = 'fresh' | 'stale' | 'missing';

type FailureReason =
  | 'not_connected'
  | 'timeout'
  | 'http_error'
  | 'blocked'
  | 'invalid_payload'
  | 'unknown_status'
  | 'coverage_incomplete'
  | 'overdue';

interface Coverage {
  basis: 'official_public';
  regions: string[];
  componentScope: 'full' | 'filtered' | 'events_only';
  currentState: 'complete' | 'partial' | 'unavailable';
  history: 'native' | 'observed' | 'mixed' | 'none';
  observedSince: string | null;
  nativeHistoryEarliestAt: string | null;
  limitation: string | null;
}

interface CollectionState {
  outcome: 'success' | 'partial' | 'failure' | 'not_connected';
  freshness: Freshness;
  reason: FailureReason | null;
  message: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  sourceUpdatedAt: string | null;
  durationMs: number | null;
  consecutiveFailures: number;
}
```

`currentState=complete` 表示已完整验证注册表声明的范围，并非整个厂商所有产品。只有 `currentState=complete` 且必需实时请求完整成功，才能更新 `lastSuccessAt` 并输出 `freshness=fresh`。

实时数据完整而历史补全失败时，`outcome=partial`，当前状态仍可 `fresh`，但必须单列历史补全错误。实时覆盖不完整时则 `freshness=stale`。

公开状态推导：

```text
freshness != fresh                       → status=stale
reportedStatus == null                   → status=stale
其他                                     → status=reportedStatus
```

服务异常排序为 `major_outage > partial_outage > degraded > maintenance > operational`。`stale` 属于数据状态，不参与服务严重度比较；全局受阻计数独立输出。

首次没有可信数据：`reportedStatus=null`、`freshness=missing`、`status=stale`。后续采集失败：保留上次可信 `reportedStatus`、组件和活跃事件作为历史快照，同时 `freshness=stale`。

## 3. 厂商注册表

统一使用 `registry/providers.json`，不再同时维护 YAML。

```typescript
interface ProviderConfig {
  id: string;
  name: string;
  category: Category;
  aliases: string[];
  tags: string[];
  officialStatusUrl: string;
  officialHomeUrl: string | null;
  displayOrder: number;
  enabled: boolean;
  adapter: {
    type:
      | 'statuspage-v2'
      | 'incident-io'
      | 'deepseek'
      | 'google-cloud-json'
      | 'apple-status'
      | 'azure-status'
      | 'aws-cn-health'
      | 'tencent-cloud'
      | 'aliyun'
      | 'baidu-cloud';
    endpoints: Record<string, string>;
    sourcePageId?: string;
    timeoutMs: number;
    retries: number;
    requiredRegions: string[];
    componentGroups: Array<{
      id: string;
      name: string;
      upstreamIds: string[];
      namePatterns: string[];
    }>;
    componentDisplay?: {
      excludeIds: string[];
      collapseOperational: boolean;
    };
    browserFallback: boolean;
  };
}
```

所有厂商必须有显式适配器类型；不存在适配器时输出 `not_connected`，不能返回正常空对象。未知注册表字段在开发阶段报错；重复 ID、非法 URL 和重复地域须验证。

`incident-io` 要求配置公开页面的 `sourcePageId`，与官方 URL 和响应内身份联合验证。腾讯云、阿里云、百度云要求非空的显式 `requiredRegions`；“完整”仅指该配置范围，不能暗示覆盖整个上游地域目录。

## 4. 适配器契约

```typescript
interface Component {
  id: string;
  upstreamId: string | null;
  groupId: string | null;
  name: string;
  aliases: string[];
  region: string | null;
  reportedStatus: ServiceStatus | null;
  displayCollapsed?: boolean;
}

interface AdapterResult {
  providerId: string;
  reportedStatus: ServiceStatus | null;
  components: Component[];
  incidents: SourceIncident[];
  coverage: Coverage;
  sourceUpdatedAt: string | null;
  evidence: {
    requiredChecks: Array<{
      name: string;
      passed: boolean;
      checkedAt: string;
    }>;
    historyCompleteThrough: string | null;
    historyError?: FailureReason | null;
    currentIncidentIds?: string[];
    warnings: string[];
  };
}

interface AdapterContext {
  now: string;
  signal: AbortSignal;
  http: HttpClient;
  browser: BrowserPool;
}

interface HttpResponse {
  url: string;
  status: number;
  contentType: string | null;
  encoding: string;
  durationMs: number;
  bytes: Uint8Array;
  text: string;
}

interface HttpClient {
  getText(url: string, signal: AbortSignal): Promise<string>;
  getJson(url: string, signal: AbortSignal): Promise<unknown>;
  getResponse(url: string, signal: AbortSignal): Promise<HttpResponse>;
}

interface BrowserPool {
  collect(
    providerId: string,
    url: string,
    signal: AbortSignal,
    responseMatcher: (url: string) => boolean,
    options?: BrowserCollectionOptions
  ): Promise<BrowserResponse[]>;
  close(): Promise<void>;
}

interface BrowserResponse {
  url: string;
  status: number;
  body: string;
  requestScope?: Record<string, string>;
}

interface BrowserCollectionOptions {
  requestScopeFields?: string[];
  steps?: Array<{
    clickText: string;
    waitFor: { url: string; requestFields?: Record<string, string> }
      | Array<{ url: string; requestFields?: Record<string, string> }>;
  }>;
}

interface Adapter {
  collect(config: ProviderConfig, context: AdapterContext): Promise<AdapterResult>;
}
```

浏览器响应匹配必须由已验证接口规则决定，不用“所有 application/json 响应中的第一个”。`BrowserPool.collect` 的入参不表达完整校验逻辑，适配器仍须校验业务状态、范围和字段。

地域切换使用声明式的普通界面点击，并在点击前注册精确 URL 与地域请求字段的响应等待；页面空闲不代表异步地域数据完整。`requestScope` 只保留显式选择的公开查询字段，不包含请求头、Cookie、完整请求体或页面内置 token；不向适配器暴露原始 Playwright page。

首批实现增加 `getResponse`，让探测脚本复用同一传输层并记录原始字节、编码与响应摘要；增加 `close`，让采集入口负责释放共享浏览器资源。普通解析器仍优先使用 `getJson` / `getText`。

`collect` 的调用等待受截止时间约束；被取消任务的内部并发名额保留到 context 实际关闭。`close` 等待已拥有任务的回收及浏览器实际关闭，并报告关闭错误；它不承诺协议永久卡死时仍能在调用预算内完成物理回收。

适配器返回的服务状态，必须与组件和活跃事件一致；冲突产生明确 warning 或失败。未知枚举不能默认映射为 `operational`。

`componentDisplay` 以配置声明说明项排除与正常组件折叠。折叠组件仍保留在 `components` 中，仅标记 `displayCollapsed`，确保全量搜索可用。排除说明组件时 `componentScope=filtered`，单纯折叠仍为 `full`。

`historyError` 表达历史补全失败，不能靠匹配 warning 文案控制流程。`currentIncidentIds` 保存本轮已验证当前事件的 `sourceIdentity`，将它们与有限历史候选分开；历史候选不因仍在数组中就成为活跃故障。缺少此字段不代表已验证当前事件为空。

`SourceIncident` 是下一节定义的无状态上游事件候选。适配器不分配 episode，不创建合成事件；只有归并层访问历史并确定最终生命周期 ID。

### 4.1 最小采集边界

以下内部类型位于 `src/collector/types.ts`，在首批编码的 Task 3 实现，Task 6 在其基础上增加持久化与事件归并：

```typescript
interface ProviderCollection {
  providerId: string;
  officialStatusUrl?: string;
  result: AdapterResult | null;
  lastTrustedResult: AdapterResult | null;
  collection: CollectionState;
}

interface CollectionRun {
  snapshotId: string;
  startedAt: string;
  completedAt: string;
  intervalMinutes: number;
  providers: ProviderCollection[];
}
```

`result` 只保存本轮通过完整实时检查的结果；失败时为 `null`。`lastTrustedResult` 用于保留上次可信服务信息，不能改变本轮受阻的新鲜度。首次失败没有可信历史时为 `null`。

`collectProviders(configs, previous, context)` 中的 `previous` 为 `ReadonlyMap<string, ProviderCollection>`；`context` 提供当前时钟、共享 HTTP / browser、全局取消信号和目标周期。CLI 可输出本轮报告；持久化由下述入口负责。

`officialStatusUrl` 由注册表传入，供没有原生事件链接的观测事件使用。`context.clock` 可注入 UTC 时钟和单调计时器；开始、完成与各厂商的尝试时间分开记录，不将固定的运行开始时间当成所有请求的完成时间。

持久化入口为 `runPersistentCollection(configs, context, directory)`，返回 `{kind: 'valid', run, state, hasProviderFailures}`。有效的厂商失败结果保留 `stale` 并正常持久化；存储或协议错误抛出，不替换已有状态。持久模式采集全部启用厂商，不能用单厂商诊断结果替换完整快照。

## 5. 事件

```typescript
type IncidentState =
  | 'investigating'
  | 'identified'
  | 'monitoring'
  | 'resolved'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'unknown';

type IncidentKind = 'incident' | 'maintenance' | 'advisory';

interface Incident {
  id: string;
  sourceIdentity: string;
  episode: number;
  providerId: string;
  upstreamId: string | null;
  kind: IncidentKind;
  title: string;
  severity: Exclude<ServiceStatus, 'operational'> | null;
  sourceSeverity: string | null;
  severityBasis: 'source' | 'component' | 'derived' | 'unknown';
  state: IncidentState;
  origin: 'official' | 'observed';
  isSynthetic: boolean;
  affectedComponentIds: string[];
  affectedRegions: string[];
  startedAt: string;
  startTimeBasis:
    | 'source_started_at'
    | 'source_created_at'
    | 'source_published_at'
    | 'source_reopened_at'
    | 'first_observed';
  resolvedAt: string | null;
  resolvedTimeBasis: 'source' | 'first_observed' | null;
  lastObservedAt: string;
  updatedAt: string;
  durationMinutes: number | null;
  sourceUrl: string;
  postmortemUrl: string | null;
  supersededBy: string | null;
  updates: Array<{
    id: string;
    phase: IncidentState;
    body: string;
    timestamp: string;
  }>;
}

interface SourceIncident extends Omit<
  Incident,
  'id' | 'episode' | 'supersededBy' | 'origin' | 'isSynthetic'
> {
  origin: 'official';
  isSynthetic: false;
}
```

原生事件的 `sourceIdentity` 使用 `providerId + upstreamId`；仅有 URL 的源使用规范化官方 URL 的稳定摘要。生命周期事件的 `id` 为 `sourceIdentity + episode`，从 episode 1 开始；同一上游事件恢复后再打开，创建 episode 2，保留 episode 1 的时间与更新记录。统计、分片和通知都按生命周期事件 ID 处理。

没有稳定事件线程 ID、也没有独立事件 URL 的来源，不能把共享首页当成所有事件的同一身份。腾讯云当前公开通道仅证实更新 ID，采用厂商、地域、产品与首条已提供更新 ID 的摘要，`upstreamId=null`，并披露有限更新窗口截断可能引起身份变化。该标识只保证相同输入重跑稳定，不宣称跨截断窗口的线程唯一性，也不能自动合并未经证实的事件。

重开的开始时间优先采用上游明确重开时间或上次恢复后的第一条活跃阶段更新，标记 `source_reopened_at`；没有可靠时间则采用首次观测并标记 `first_observed`。不得沿用最初的 `created_at`，也不能将上次 episode 的更新和恢复间隔计入本次影响时长。

合成事件的 `sourceIdentity` 使用 provider、组件、地域及首次异常观测时间，默认 episode 1，不能使用每轮随机 ID。合成事件恢复后再次异常使用新的观测事件，不复用上次区间。

`origin=observed` 与 `isSynthetic=true` 必须一致。合成事件的 `sourceUrl` 指向官方状态页，不能伪造具体故障详情 URL。

缺少可靠的官方结束时间时，`resolvedAt` 和 `durationMinutes` 保持 `null`。上游明确表示已恢复但未提供结束时间，可将 `state=resolved`，同时提示“结束时间未提供”，不能自动用抓取时间充当官方时间。

只有公开发布时间的来源使用 `source_published_at`，不将 RSS 发布时间冒充实际故障开始时间。按发布或创建时间定位的事件仍可进入历史库，但缺少可靠故障起止时，不计入官方已报告影响时长。

未来维护窗口 `state=scheduled` 不使当前服务进入维护；只有当前进行中的维护才参与当前状态。建议事件不计入活跃故障总数。

### 5.1 合成事件状态迁移

| 上轮可信状态 / 事件 | 本轮结果 | 动作 |
| --- | --- | --- |
| 无可信状态 | 采集失败 / 不完整 | 标记无数据；不创建故障 |
| 无 / 正常 | 完整异常，缺少覆盖它的原生事件 | 创建观测事件，开始时间为本轮观测时间 |
| 已有观测事件 | 完整异常 | 更新最后观测时间；仅在范围或严重度变化时追加更新 |
| 已有观测事件 | 失败、受阻或实时覆盖不完整 | 保留打开状态；不推进服务生命周期 |
| 已有观测事件 | 完整正常 | 以本轮观测时间恢复，标注观测时间精度 |
| 已有观测事件 | 出现同范围、重叠时间的原生事件 | 归并别名，观测事件标记 `supersededBy`，统计去重 |
| 已恢复观测事件 | 再次完整异常 | 创建新的观测事件，不覆盖上次恢复历史 |

同一厂商多个组件异常可产生多个观测事件；全局异常厂商数与活跃事件数必须分开。

### 5.2 通知账本

```text
<incidentId>:triggered
<incidentId>:escalated:<updateId>
<incidentId>:resolved
```

`incidentId` 已包含 episode；上游复用 ID 并重新打开时生成新的生命周期事件 ID。严重度升级使用稳定更新 ID；重复采集和发布重试不生成新里程碑。生命周期账本与持久状态一同保存。

已推送的观测事件被原生事件替代后，保留通知别名关系，不再为同一故障生成第二次触发通知。

## 6. 公共 API

```typescript
interface Envelope {
  schemaVersion: '1.0';
  snapshotId: string;
  generatedAt: string;
  intervalMinutes: number;
  dataMode: 'live' | 'fixture';
}

interface ProviderSummary {
  id: string;
  name: string;
  category: Category;
  status: PublicStatus;
  reportedStatus: ServiceStatus | null;
  officialStatusUrl: string;
  collection: CollectionState;
  coverage: Coverage;
  componentSummary: {
    total: number;
    abnormal: number;
    abnormalNames: string[];
    affectedRegions: string[];
  };
  dailyTrack30d: string;
  activeIncidents: Array<{
    id: string;
    title: string;
    severity: Incident['severity'];
    origin: Incident['origin'];
    startedAt: string;
    updatedAt: string;
    sourceUrl: string;
  }>;
}

interface Summary extends Envelope {
  globalSummary: {
    overallStatus: PublicStatus;
    totalProviders: number;
    connectedProviders: number;
    countsByStatus: Record<PublicStatus, number>;
    abnormalProviderCount: number;
    activeIncidentCount: number;
    maintenanceCount: number;
    staleProviderCount: number;
  };
  providers: ProviderSummary[];
}

interface ProviderDetail extends Envelope {
  provider: ProviderSummary;
  componentGroups: Array<{ id: string; name: string; components: Component[] }>;
  dailyHistory30d: DailyStat[];
  recentIncidents: Incident[];
  warnings: string[];
}
```

摘要中的活跃事件仅存展示摘要，完整更新保存在详情和事件库。异常组件名称做去重和可解释截断；完整列表仍可在详情与索引中找到。

全局状态规则：

1. 存在可信的服务故障，显示其中最高严重度，同时显示受阻数量。
2. 无服务故障但有受阻 / 缺失厂商，`overallStatus=stale`，不得显示“全部正常”。
3. 无故障且无受阻但有进行中维护，`overallStatus=maintenance`。
4. 所有启用厂商均可信正常，才允许 `overallStatus=operational`。

若本地发现整份快照超过三周期，前端将展示层整体标记过期；不能因文件内部 `freshness=fresh` 而继续显示绿灯。

### 6.1 manifest 与冷归档

```typescript
interface Manifest extends Envelope {
  archiveIndexRevision: string;
  paths: {
    summary: string;
    providers: Record<string, string>;
    recentIncidents: string;
    health: string;
    search: string;
    archiveIndex: string;
  };
}

interface ArchiveIndex {
  schemaVersion: '1.0';
  revision: string;
  generatedAt: string;
  months: Array<{
    month: string;
    revision: string;
    path: string;
    incidentCount: number;
    minStartedAt: string | null;
    maxResolvedAt: string | null;
    updatedAt: string;
  }>;
}

interface IncidentArchive {
  schemaVersion: '1.0';
  month: string;
  revision: string;
  updatedAt: string;
  incidents: Incident[];
}
```

`Manifest.paths.archiveIndex` 指向 `/api/v1/incidents/archive/indexes/{revision}.json`，且 revision 必须等于 `archiveIndexRevision`。`ArchiveIndex.months[].path` 指向 `/api/v1/incidents/archive/{month}/{revision}.json`。内容有变化才生成新 revision，不在原不可变路径覆盖不同内容。

固定路径 `/api/v1/incidents/archive/index.json` 和 `/api/v1/incidents/archive/{month}.json` 是最新版本别名，供外部兼容使用。前端优先使用不可变路径并核对响应体版本。

保留最近 60 分钟内及最近 12 个热快照所引用的索引和月度版本，另保留每月最近两个版本。旧版本被清理而返回 404 时，前端重新获取 manifest 和索引一次，按新路径重试；仍失败时报告错误，不无限重试或混读。

### 6.2 搜索

```typescript
interface SearchIndex extends Envelope {
  providers: Array<{
    providerId: string;
    names: string[];
    components: string[];
    regions: string[];
    incidentTitles: string[];
  }>;
}
```

索引包含配置别名、全部已成功发现的组件名和地域，即使卡片不显示正常边缘节点，也可通过搜索定位厂商。过期组件索引保留上次可信版本并继承厂商的新鲜度提示。

## 7. 日统计与热力条

```typescript
interface DailyStat {
  date: string;
  worstStatus: ServiceStatus | null;
  incidentCount: number;
  reportedImpactMinutes: number | null;
  observedImpactMinutes: number | null;
  observedCoverageMinutes: number;
  unknownMinutes: number;
  hasEstimatedTimes: boolean;
}
```

`observedCoverageMinutes + unknownMinutes` 等于该 UTC 日截至统计时刻的已过去分钟数；未来时间不进入分母，不能补绿。新接入当日，接入前时间计为未知。

上次可信观测可外推到下一次采集时间，但上限为两个目标周期；失败尝试从失败时刻起计为未知。外推用于观测覆盖统计，不证明两次采样间从未发生短时故障。

`reportedImpactMinutes` 只使用具有可靠开始与结束时间的官方事件区间。`observedImpactMinutes` 单独使用观测事件区间，二者分别求并集，不能相加成官方停机时长。

热力条编码保持 30 位：

| 字符 | 含义 |
| --- | --- |
| `0` | 当日观测覆盖完整，未记录异常 |
| `1` | 已记录进行中维护，且无更高等级已知异常 |
| `2` / `3` / `4` | 已记录降级 / 局部中断 / 严重中断 |
| `9` | 没有数据，或仅正常样本但观测覆盖不完整 |

存在已知异常时，异常颜色优先；若覆盖不完整，同时叠加缺失纹理并显示覆盖分钟。只有正常样本但覆盖不足的日期，不显示完整绿格。

“完整”按无未知分钟判定；采样外推上限是显式建模假设，需要在工具提示和 API 文档说明。未满一天的当前日单独标为“今日截至当前”。

## 8. 持久化目录与恢复

```text
state/latest.json                       最近完整采集快照及协议版本
state/collector-health.json             连续失败计数、最后尝试和成功
state/open-incidents.json               全部未结束事件；不受滚动窗口淘汰
state/incident-identities.json          上游身份、最新 episode、结束边界及归并别名
state/notification-ledger.json          已生成的生命周期里程碑与别名
state/observations.json                 带周期的观测片段；保留失败与断档边界
providers/{id}.json                     上次可信组件、事件与数据来源
rollup/daily-stats-90d.json              90 天日统计
incidents/recent-30d.json                与近 30 天重叠的已知事件，加全部活跃事件
incidents/archive/index.json            月度索引
incidents/archive/{YYYY-MM}.json         按开始月份分片，可被迟到更新修订
```

所有状态先写临时 staging 目录，校验成功后再替换本地输出。只允许操作明确的生成目录，不清理仓库根目录或未声明文件。

观测片段保存起点、最后一次相容观测时间、该片段的目标周期与状态。相容样本可以合并，但周期切换、状态变化、失败及超出外推上限的断档必须保留边界。日统计窗口为 90 个 UTC 日期；边界处保留计算覆盖所需的前驱片段，全部活跃事件及其原始月份不随该窗口淘汰。

重跑相同输入应在事件集合、里程碑、统计和归档内容上幂等；运行时间和健康耗时允许变化。读取到更高 schema 主版本时停止写入，不自动降级。

状态缺失首次初始化与状态损坏必须分别报错。恢复操作从日备份加载并重新跑发布校验，不能直接将备份推上远端。
