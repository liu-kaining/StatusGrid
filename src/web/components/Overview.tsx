import type { Summary } from '../../shared/contracts.js';
import { ageLabel, snapshotFreshness, timeLabel } from '../data/queries.js';

export function Overview({ summary, refreshing, refresh, now }: {
  summary: Summary; refreshing: boolean; refresh: () => void; now: number;
}) {
  const totals = summary.globalSummary;
  const freshness = snapshotFreshness(summary.generatedAt, summary.intervalMinutes, now);
  const metrics = [
    ['快照内可信源', `${totals.connectedProviders}`, `/ ${totals.totalProviders}`, 'neutral'],
    ['异常厂商', String(totals.abnormalProviderCount), 'PROVIDERS', 'fault'],
    ['活跃故障', String(totals.activeIncidentCount), 'INCIDENTS', 'fault'],
    ['计划维护', String(totals.maintenanceCount), 'MAINTENANCE', 'maintenance'],
    ['采集受阻', String(totals.staleProviderCount), 'UNVERIFIED', 'stale'],
  ];
  return <>
    <div className="section-heading overview-heading"><div><span className="eyebrow">SYSTEM OVERVIEW / 态势总览</span><h1>服务状态观测台<span className="heading-period">.</span></h1></div>
      <div className="snapshot-meta"><span className={`freshness-tag freshness-${freshness}`}><i />{freshness === 'fresh' ? '快照已同步' : freshness === 'delayed' ? '快照延迟' : '快照已过期'}</span>
        <time dateTime={summary.generatedAt}>{timeLabel(summary.generatedAt)}</time>
        <span>数据年龄 {ageLabel(summary.generatedAt, now)} · 每 {summary.intervalMinutes} 分钟采集</span>
      </div>
    </div>
    <div className="overview-metrics">{metrics.map(([label, value, suffix, tone]) =>
      <div className={`metric metric-${tone}`} key={label}><span>{label}</span><div><b>{value}</b><small>{suffix}</small></div></div>)}
      <button className="refresh-button" aria-label="刷新数据" disabled={refreshing} onClick={refresh}><span className={refreshing ? 'refreshing' : ''}>↻</span>{refreshing ? '检查中' : '刷新数据'}<small>60s 自动检查</small></button>
    </div>
    {summary.dataMode === 'fixture' && <div className="fixture-banner"><b>FIXTURE / 演示数据</b><span>独立预览环境 · 场景由真实导出器生成，不代表厂商当前状态</span></div>}
    {freshness !== 'fresh' && <div className="age-warning" role="status">△ {freshness === 'stale' ? '当前为过期快照' : '新快照尚未到达'}，数据年龄 {ageLabel(summary.generatedAt, now)}。服务结论仅代表快照时刻；超过 {summary.intervalMinutes * 2} / {summary.intervalMinutes * 3} 分钟分别提示延迟 / 过期。</div>}
  </>;
}
