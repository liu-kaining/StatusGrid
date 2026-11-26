import { useEffect, useState } from 'react';
import type { Incident, Summary } from '../../shared/contracts.js';
import { dataClient, SnapshotChangedError } from '../data/client.js';
import { faultSeverities } from '../state/url.js';
import { statusLabels } from '../data/queries.js';
import type { FaultSeverity, HistoryRange, ViewState } from '../state/types.js';
import { IncidentTimeline } from './IncidentTimeline.js';
import { StateNotice } from './StateNotice.js';

export function HistoryView({ summary, state, change, refresh }: {
  summary: Summary; state: ViewState; change: (patch: Partial<ViewState>) => void; refresh: () => Promise<void>;
}) {
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const severityKey = state.severity.join(',');
  const providersKey = state.providers.join(',');
  useEffect(() => {
    const controller = new AbortController();
    setIncidents(null); setError('');
    dataClient.loadHistory({ snapshotId: summary.snapshotId, range: state.range, month: state.month,
      severity: severityKey ? severityKey.split(',') as FaultSeverity[] : [],
      providers: providersKey ? providersKey.split(',') : [] }, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setIncidents(value); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof SnapshotChangedError) void refresh();
        setError(reason instanceof Error ? reason.message : '未知请求错误');
      });
    return () => controller.abort();
  }, [summary.snapshotId, state.range, state.month, severityKey, providersKey, attempt, refresh]);
  return <section className="history-view">
    <div className="section-heading"><div><span className="eyebrow">INCIDENT VAULT / 事件档案</span><h2>每一次异常，都有迹可循<span className="heading-period">.</span></h2></div><span className="mono muted">{incidents?.length ?? '—'} EVENTS</span></div>
    <div className="history-filters">
      <label>时间范围<select aria-label="历史时间范围" value={state.range} onChange={(event) => change({ range: event.target.value as HistoryRange })}>
        <option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="90d">近 90 天</option><option value="month">按月归档</option></select></label>
      {state.range === 'month' && <label>归档月份<input type="month" aria-label="归档月份" value={state.month || summary.generatedAt.slice(0, 7)} onChange={(event) => change({ month: event.target.value })} /></label>}
      <label>厂商<select aria-label="历史厂商" value={state.providers.length === 1 ? state.providers[0] : ''} onChange={(event) => change({ providers: event.target.value ? [event.target.value] : [] })}>
        <option value="">{state.providers.length > 1 ? `已选 ${state.providers.length} 个厂商` : '全部厂商'}</option>{summary.providers.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label>严重度<select aria-label="严重度" value={state.severity.length === 1 ? state.severity[0] : ''} onChange={(event) => change({ severity: event.target.value ? [event.target.value as FaultSeverity] : [] })}>
        <option value="">{state.severity.length > 1 ? `已选 ${state.severity.length} 个级别` : '全部级别 / 含维护与建议'}</option>{faultSeverities.map((severity) => <option key={severity} value={severity}>{statusLabels[severity]}</option>)}</select></label>
    </div>
    <p className="history-caption">官方故障、维护与建议分别标注。观测事件使用估计时间；未完结事件跨月持续可见。</p>
    {error ? <StateNotice title="历史加载失败" tone="error" retry={() => setAttempt((value) => value + 1)}>{error}</StateNotice>
      : incidents === null ? <StateNotice title="正在读取事件索引与归档…" />
        : !incidents.length ? <StateNotice title="此范围内没有事件">可调整时间、厂商或严重度筛选。</StateNotice>
          : <IncidentTimeline incidents={incidents} providerNames={Object.fromEntries(summary.providers.map(({ id, name }) => [id, name]))} />}
  </section>;
}
