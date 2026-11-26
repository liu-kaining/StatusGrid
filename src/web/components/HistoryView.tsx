import { useEffect, useState } from 'react';
import type { Incident, Summary } from '../../shared/contracts.js';
import { dataClient, SnapshotChangedError } from '../data/client.js';
import { faultSeverities } from '../state/url.js';
import { statusLabels } from '../data/queries.js';
import type { FaultSeverity, HistoryRange, ViewState } from '../state/types.js';
import { IncidentTimeline } from './IncidentTimeline.js';
import { StateNotice } from './StateNotice.js';
import { SelectField } from './SelectField.js';

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
      <SelectField label="历史时间范围" caption="时间范围" value={state.range} onChange={(value) => change({ range: value as HistoryRange })}
        options={[{ value: '7d', label: '近 7 天' }, { value: '30d', label: '近 30 天' }, { value: '90d', label: '近 90 天' }, { value: 'month', label: '按月归档' }]} />
      {state.range === 'month' && <label>归档月份<input type="month" aria-label="归档月份" value={state.month || summary.generatedAt.slice(0, 7)} onChange={(event) => change({ month: event.target.value })} /></label>}
      <SelectField label="历史厂商" caption="厂商" value={state.providers.length > 1 ? '__multiple__' : state.providers[0] ?? ''}
        selectionLabel={state.providers.length > 1 ? `已选 ${state.providers.length} 个厂商` : undefined}
        onChange={(value) => change({ providers: value ? [value] : [] })}
        options={[{ value: '', label: '全部厂商' }, ...summary.providers.map(({ id, name }) => ({ value: id, label: name }))]} />
      <SelectField label="严重度" value={state.severity.length > 1 ? '__multiple__' : state.severity[0] ?? ''}
        selectionLabel={state.severity.length > 1 ? `已选 ${state.severity.length} 个级别` : undefined}
        onChange={(value) => change({ severity: value ? [value as FaultSeverity] : [] })}
        options={[{ value: '', label: '全部级别 / 含维护与建议' }, ...faultSeverities.map((severity) => ({ value: severity, label: statusLabels[severity] }))]} />
    </div>
    <p className="history-caption">官方故障、维护与建议分别标注。观测事件使用估计时间；未完结事件跨月持续可见。</p>
    {error ? <StateNotice title="历史加载失败" tone="error" retry={() => setAttempt((value) => value + 1)}>{error}</StateNotice>
      : incidents === null ? <StateNotice title="正在读取事件索引与归档…" />
        : !incidents.length ? <StateNotice title="此范围内没有事件">可调整时间、厂商或严重度筛选。</StateNotice>
          : <IncidentTimeline incidents={incidents} providerNames={Object.fromEntries(summary.providers.map(({ id, name }) => [id, name]))} />}
  </section>;
}
