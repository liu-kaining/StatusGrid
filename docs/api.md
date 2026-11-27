# 公共 API 与订阅

线上根地址为 `https://grid.thetamind.ai`，所有路径都是静态只读文件，不需要认证。当前 API 版本 `1.0`；运行时定义见 `src/shared/contracts.ts`、`src/shared/public-schemas.ts`。客户端须检查 HTTP 状态、schema 和版本，不能把失败响应当作空事件。

| 路径 | 内容 |
| --- | --- |
| `/api/v1/manifest.json` | 当前快照 ID、时间、模式及所有版本化入口 |
| `/api/v1/summary.json` | 固定路径摘要兼容别名 |
| `/api/v1/providers/{id}.json` | 厂商摘要、完整组件分组、30 日日统计、事件、限制 |
| `/api/v1/incidents/recent.json` | 近期及跨窗口活跃事件 |
| `/api/v1/meta/health.json` | 运行耗时、来源类型、逐厂商采集健康与最近发布 ID |
| `/api/v1/search.json` | 名称／别名／组件／地域／事件标题独立索引 |
| `/api/v1/incidents/archive/index.json` | 最新月度索引兼容别名 |
| `/api/v1/incidents/archive/{YYYY-MM}.json` | 最新月份兼容别名 |
| `/api/v1/snapshots/{snapshotId}/manifest.json` | 该热版本的完整引用 |
| `/api/v1/snapshots/{snapshotId}/…` | summary、providers、incidents/recent、meta/health、search，同名相对路径 |
| `/api/v1/incidents/archive/indexes/{revision}.json` | 不可变冷索引 |
| `/api/v1/incidents/archive/{YYYY-MM}/{revision}.json` | 不可变月度分片 |
| `/feed/all.xml` | 全局 RSS |
| `/feed/atom.xml` | 全局 Atom |
| `/feed/category/{cat}.xml` | 分类 RSS：ai、cloud-cn、cloud-global、infra |
| `/feed/provider/{id}.xml` | 单厂商 RSS |

厂商 ID：cloudflare、github、claude、openai、moonshot、deepseek、minimax、streamlake、gcp、apple-cn、azure、aws-cn、tencent-cloud、aliyun、baidu-cloud。以 `registry/providers.json` 的启用项为准。

## 一致读取

先获取 manifest，核对 `schemaVersion`／`dataMode`，沿 `paths.summary` 读取，要求每个热响应的 `snapshotId` 等于 manifest。详情、健康、搜索和近期事件都使用同一 manifest 中的路径，不将固定兼容别名混入一致视图。

需要历史时读取 `paths.archiveIndex`，要求其 `revision` 等于 `archiveIndexRevision`；然后沿 `months[].path` 读取并核对月／revision。冷文件没有 snapshotId，按内容 revision 绑定。月份按事件开始的 UTC 月份归档；迟到恢复／复盘可产生旧月的新 revision，跨月活跃事件不能只读当前月。近期文件与归档需按生命周期 `id` 去重，并排除 `supersededBy` 已替代记录。

热版本保留最近 60 分钟内全部版本，且至少 12 个；它们引用的冷索引／月版本全部保留，每月另保留最近两个 revision。旧热／冷文件 404 时刷新 manifest／索引一次重新定位，仍失败报告错误，禁止无限重试或静默混用。现有前端将 retired-history 错误传给 App 刷新，悬浮与每日页也执行同一机制。

每日路由 `?view=day&provider={id}&date=YYYY-MM-DD` 是 UI 路由，没有额外每日 API。读取 summary 的覆盖与详情日统计，懒加载同版本历史；UTC 日半开区间保留跨日持续事件，午夜恢复归前一天，零时长事件归开始日。未恢复事件只延伸至快照观测上限。组件名称是关联标签，不是历史组件状态。

## 时间、来源与未知

热文件 Envelope 包含 `schemaVersion`、`snapshotId`、`generatedAt`、`intervalMinutes`、`dataMode=live|fixture`。fixture 标识必须保留；生产校验 `--require-live` 拒绝任何热／冷 fixture，不能把改标识当作真实采集。

公共冷索引 `generatedAt` 是引用月份的最新 `updatedAt`，空索引为 null；它不是本轮发布时间。月度分片用 `updatedAt`。其余可空字段包括 `sourceUpdatedAt`、未成功过的 `lastSuccessAt`、缺失来源时间、未知组件地域／状态、事件 `resolvedAt`／`durationMinutes`、无可信日影响统计。保持 null，不用 epoch、0 或抓取时间伪造事实。

`status=stale` 表示数据不可信；`reportedStatus` 保留上次官方服务结论，二者不冲突。`collection` 给出 `outcome`、`freshness=fresh|stale|missing`、原因、尝试／成功／来源时间、耗时和连续失败次数。完整实时成功但可选历史失败可以 `outcome=partial,freshness=fresh`；具体历史限制在详情 warnings 中。

即使文件内 freshness=fresh，消费端也必须按 generatedAt 计算快照年龄：两周期延迟、三周期过期，分别为 5 分钟配置下 10／15 分钟、10 分钟下 20／30 分钟。官方来源长时间无变更本身不意味着采集过期。

事件区分 `origin=official|observed`、`isSynthetic`、`startTimeBasis`／`resolvedTimeBasis`、种类、严重度依据、episode 和官方链接。发布时间／创建时间不承诺故障开始；没有结束时间保留 null；从有限列表消失不能推断恢复。腾讯公开通道无稳定线程 ID，身份为配置范围和首条可见更新的摘要，有限窗口截断可能产生额外身份。

## 日覆盖与 Feed

`dailyTrack30d` 的 30 字符和 `dailyCoverage30d` 的 30 项按 `generatedAt` 的 UTC 日期从旧到新对齐。0=完整正常，1=维护，2／3／4=降级／局部／严重，9=未知或仅正常但覆盖不足。异常仍需同时展示 unknownMinutes。详情日统计分别给出官方／观测影响、已观测／未知分钟及时间估计标识；覆盖总和仅为截至统计时刻已过去分钟，不包含未来。

覆盖外推最多两个原始周期，并在失败时终止，是采样模型而非 SLA。官方可靠区间与观测区间分别求并集，不相加成官方停机时长。

Feed 条目 ID 按生命周期事件和 triggered／escalated／resolved 里程碑稳定生成；重开使用新 episode。普通文案更新不刷条目，重采集和相同状态重新发布不重复里程碑。观测事件被官方事件替代时保留别名关系。输出文本／XML 转义，客户端不要直接执行上游 HTML。

缓存 TTL、查询参数缓存键、Date／Age／ETag 和跨域 CORS 需在目标域名实测；本地同源可读不能证明 CORS。外部消费者若浏览器跨域被拒，可使用服务端读取；不能宣称 GitHub Pages 可随意设置自定义响应头。部署配置与故障恢复见 [部署文档](deployment.md)。
