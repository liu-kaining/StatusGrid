# 本地运行与恢复手册

安装和首次真实采集见 [README](../README.md)，线上入口及权限见 [部署手册](deployment.md)。所有示例从仓库根目录执行；`.statusgrid/state` 是内部生成根，`public` 是导出目标，二者不可重叠。报告也不能放进这两个目标内部。

## 采集模式与退出码

```sh
# 指定来源只读诊断：仅生成报告，不读写持久状态、不发布
npm run collect -- --providers github,openai --interval 5 --report .statusgrid/diagnostic.json
# 持久模式：全部启用来源；可省略 output-dir，仅保存内部状态
npm run collect -- --state-dir .statusgrid/state --output-dir public --report .statusgrid/run.json
# 保存原始传输证据；不等于语义通过
npm run probe -- --provider aws-cn --output .statusgrid/probes
```

`--interval` 只选择 5／10 分钟的目标周期和统计元数据，不是 watch。持久模式禁止 `--providers`；已经保存的来源集合不能缩小，必须先设计并验证显式迁移。修改注册表然后删除状态来绕过校验会丢失生命周期与账本。

| 退出码 | collect 含义 |
| --- | --- |
| 0 | 全部诊断来源实时成功，或合法持久运行（允许来源失败形成 stale） |
| 1 | 诊断存在来源失败；不会写持久状态 |
| 2 | 参数、存储、契约、锁或清理异常；停止并检查，不能忽略 |

持久运行退出 0 不表示 13 家均成功，必须查看报告的 `providers[].collection`。`result=null` 是本轮失败，`lastTrustedResult` 仅是历史；`outcome=partial` 可能表示必需实时成功但可选历史失败。导出在持久状态成功后执行；若导出失败，状态可能已更新而公共 manifest 仍是上一轮。

可选本地循环，在独立终端前台执行，Ctrl-C 停止；不会由 UI 启动：

```sh
while true; do
  npm run collect -- --state-dir .statusgrid/state --output-dir public --report .statusgrid/run.json
  collection_exit=$?
  if [ "$collection_exit" -ne 0 ]; then
    echo "Collection infrastructure failed: $collection_exit"
    break
  fi
  sleep 300
done
```

这是“完成后等待 300 秒”，不保证严格墙钟 5 分钟。10 分钟时采集增加 `--interval 10`，等待改为 600。不要同时对同一状态目录启动多个采集器。

## 读懂健康与历史

`reportedStatus` 是最近可信官方服务结论；`collection.freshness` 是本轮数据可信度。源超时后上次服务可能健康，但当前数据仍必须 stale。`lastCheckedAt` 是最近尝试，`lastSuccessAt` 是最近必需实时完整成功，`sourceUpdatedAt` 是源站自带更新时间（可为 null），`generatedAt` 是本站快照时间。

任一必需实时失败立即受阻；没有新快照时页面还按整个快照年龄计算两周期延迟、三周期过期。5 分钟对应 10／15 分钟，10 分钟对应 20／30 分钟；按阈值到达即提示。可见页面 60 秒检查一次，隐藏时暂停、回到前台立即检查。手动刷新不采集上游。

日轨迹和每日页按快照 UTC 日历，不随本机过午夜改写日期。覆盖外推最多两个原采样周期，失败时刻即截断；漏跑、接入前和过期断档是未知。正常样本但不完整覆盖为灰色；已知异常可为红色并带下缘覆盖提示，维护为蓝色，完整正常为绿色。未知分钟、官方／观测影响分别展示；空事件列表不证明健康，创建／发布时间不等于确认故障开始。

`?view=day&provider=openai&date=2026-11-26` 示例需替换为实际窗口日期。悬浮与日页共用按快照隔离的懒加载历史，支持键盘、触屏及前进后退。旧版本被清理会刷新 manifest 后按新快照重读；普通网络失败可重试。非法日期、未知厂商、窗外日期明确报出，窗外可进入月度归档。

## 状态布局与只读校验

```text
.statusgrid/state/                       --state-dir 生成根
  .statusgrid-state.json                 声明完整文件清单
  state/latest.json                     {schemaVersion, run}
  state/collector-health.json
  state/open-incidents.json
  state/incident-identities.json
  state/notification-ledger.json
  state/observations.json
  providers/{id}.json
  rollup/daily-stats-90d.json
  incidents/recent-30d.json
  incidents/archive/index.json
  incidents/archive/{YYYY-MM}.json
```

检查整份状态（只读；成功输出快照 ID，失败非零）：

```sh
npx tsx -e 'import {loadState} from "./src/collector/storage/load.ts"; loadState(".statusgrid/state").then(s=>{if(!s.latest) throw Error("No collected state"); console.log(s.latest.snapshotId)}).catch(e=>{console.error(e);process.exitCode=2})'
```

缺失的生成根允许首次初始化；已存在的空目录、损坏分片、额外文件、软链接、高版本 schema、统计／归档／账本不一致均拒绝覆盖。不要预先 `mkdir .statusgrid/state`。任意源码目录也不能当作生成根。

## 本地完整发布演练

先 `npm run build` 得到独立无数据前端壳，再在新目录组合已有状态。该命令不采集、不访问 Git 远端：

```sh
npx tsx -e 'import {prepareRelease} from "./scripts/prepare-release.ts"; prepareRelease("dist",".statusgrid/state",".statusgrid/dry-release").then(r=>console.log({valid:r.valid,snapshotId:r.snapshotId,summaryGzipBytes:r.summaryGzipBytes})).catch(e=>{console.error(e);process.exitCode=2})'
npm run release:check -- --dir .statusgrid/dry-release --require-live
```

目标目录必须不存在；再次演练使用新名称。`release:check` 的 0／1／2 分别表示校验通过／数据不合格／命令异常，不能仅看文件是否存在。`--require-live` 拒绝 fixture，且检查版本、归档引用、Feed 和 40 KiB 摘要预算。空态完整站点需通过 `prepareRelease` 写入 empty 收据，再以 `--allow-empty` 校验；裸 `vite build` 只生成前端壳。

## 损坏、锁和备份恢复

先停止所有本地写入器，线上先禁用／等待生产入口完成。保留原状态、报告和错误日志；不要用一轮新采集覆盖可恢复的旧账本。读取失败并不说明旧目录已不可恢复。

正常保存采用同级 staging、完整重读校验、目录 rename 和失败回滚。它不是 fsync 崩溃持久性保证：突然断电／进程退出可能留下 `.statusgrid/state.lock`，以及 `.statusgrid/.state.staging-<随机值>` 或其 `.previous` 备份。失败回滚保留 `.previous`；不要批量删除这些目录。

安全恢复顺序：

1. 用 `ps`／`lsof` 确认没有采集器／发布进程正在使用该目标；检查锁和同级候选的确切路径、修改时间、marker。锁没有可依赖的 PID 所有权记录，仅凭“锁很旧”不能删除。
2. 将锁移动到明确命名的隔离位置，例如 `mv .statusgrid/state.lock .statusgrid/state.lock-quarantine-20261126`，且仅在确认无写入者后执行。保留其内容，不使用递归通配删除。
3. 从候选或日备份复制到新的恢复根；归档先 `tar -tzf <备份>` 检查条目无绝对路径、`..` 或链接，再 `mkdir .statusgrid/restored-20261126` 并解压到该隔离目录。不在原状态上解压。对来源不明归档先在受限环境检查。
4. 把上述 `loadState` 示例中的路径替换为恢复根，执行完整只读校验；再用它运行 `prepareRelease`，对新公共目录执行 `release:check --require-live`。不存在／latest=null 不是成功恢复。
5. 校验通过后，把受损原目录改名隔离，再把已验证副本移动到目标；保留备份与隔离副本直到复核新一轮采集及 Feed／episode／账本。恢复旧快照可能丢失备份之后的观测，不能承诺 RPO=0。

生成本地已校验备份：

```sh
npx tsx -e 'import {backupState} from "./scripts/backup-state.ts"; backupState(".statusgrid/state",".statusgrid/backups/state-20261126.tar.gz").catch(e=>{console.error(e);process.exitCode=2})'
```

每日线上 Artifact 保留 30 天。远端状态恢复还需审查 `data` 当前 SHA 和分支策略，使用现有 CAS 保护，不强推未知变更。Pages 失败后的 `retry` 不需要恢复状态，见 [部署手册](deployment.md)。
