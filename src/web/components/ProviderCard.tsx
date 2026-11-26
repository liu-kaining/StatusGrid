import type { ProviderSummary } from '../../shared/contracts.js';
import { categoryLabels, statusLabels, statusSymbols, timeLabel } from '../data/queries.js';
import { HealthTrack, type DayNavigation } from './HealthTrack.js';

export function ProviderCard({ provider, generatedAt, open, snapshotExpired, ...dayNavigation }: {
  provider: ProviderSummary; generatedAt: string; snapshotExpired: boolean; open: (id: string, trigger: HTMLButtonElement) => void;
} & DayNavigation) {
  const displayStatus = snapshotExpired ? 'stale' : provider.status;
  const label = snapshotExpired ? '快照过期' : statusLabels[provider.status];
  return <article className={`provider-card status-${displayStatus}`} data-testid="provider-card" aria-label={`${provider.name} · ${label}`}>
    <div className="card-top"><span className="provider-code">{provider.id.toUpperCase()}</span><span className="card-category">{categoryLabels[provider.category]}</span></div>
    <div className="card-title-row"><h3>{provider.name}</h3><span className="status-badge"><span aria-hidden="true">{statusSymbols[displayStatus]}</span>{label}</span></div>
    <div className="card-signal">
      {snapshotExpired ? <><b>当前状态不可验证</b><p>上次可信状态：{provider.reportedStatus ? statusLabels[provider.reportedStatus] : '未知'} · 仅供历史参考</p></>
        : provider.status === 'stale' ? <><b>数据不可验证</b><p>{provider.collection.reason === 'blocked' ? '公共源请求受阻' : provider.collection.freshness === 'missing' ? '尚无可信采集结果' : '可信数据已过期'} · 不代表服务中断</p></>
        : <><b>{provider.componentSummary.abnormal ? `${provider.componentSummary.abnormal} 个异常组件` : provider.status === 'maintenance' ? '维护进行中' : '官方未报告异常'}</b>
          <p>{provider.activeIncidents[0]?.title ?? (provider.componentSummary.abnormalNames.join(' / ') || (provider.coverage.currentState === 'partial' ? '仅代表配置覆盖范围内的公开信号' : `${provider.componentSummary.total} 个组件 · 官方公开状态`))}</p></>}
    </div>
    <HealthTrack provider={provider} generatedAt={generatedAt} {...dayNavigation} />
    <div className="card-footer"><time dateTime={provider.collection.lastSuccessAt ?? undefined} title={timeLabel(provider.collection.lastSuccessAt)}>
      {provider.collection.lastSuccessAt ? `${provider.collection.lastSuccessAt.slice(11, 19)} UTC` : 'NO TRUSTED DATA'}</time>
      <div><a href={provider.officialStatusUrl} target="_blank" rel="noopener noreferrer" aria-label={`${provider.name} 官方状态`}>官方状态 ↗</a>
        <button aria-label={`查看 ${provider.name} 详情`} onClick={(event) => open(provider.id, event.currentTarget)}>详情 <span aria-hidden="true">→</span></button></div>
    </div>
  </article>;
}
