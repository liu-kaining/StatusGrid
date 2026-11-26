import { useEffect, useRef } from 'react';
import type { ProviderDetail, Summary } from '../../shared/contracts.js';
import { incidentsForDay, isCalendarDate } from '../data/day.js';
import { ageLabel, timeLabel, trackDate } from '../data/queries.js';
import { useDayHistory } from '../data/use-day-history.js';
import type { ViewState } from '../state/types.js';
import { serializeViewState } from '../state/url.js';
import { dayLabels } from './HealthTrack.js';
import { IncidentTimeline } from './IncidentTimeline.js';
import { StateNotice } from './StateNotice.js';

const minutes = (value: number | null) => value === null ? '暂无可信统计' : `${Math.round(value)} 分钟`;
export function DayView({ summary, state, detail, detailError, retryDetail, change, snapshotExpired, now }: {
  summary: Summary; state: ViewState; detail: ProviderDetail | null; detailError: string; retryDetail: () => void;
  change: (patch: Partial<ViewState>) => void; snapshotExpired: boolean; now: number;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const provider = summary.providers.find(({ id }) => id === state.provider);
  const validDate = isCalendarDate(state.date);
  const inWindow = validDate && state.date >= trackDate(summary.generatedAt, 0) && state.date <= trackDate(summary.generatedAt, 29);
  const history = useDayHistory(summary.snapshotId, Boolean(provider && inWindow));
  const events = history.incidents === null ? null : incidentsForDay(history.incidents, state.provider, state.date, summary.generatedAt);
  const day = detail?.dailyHistory30d.find(({ date }) => date === state.date);
  const index = inWindow ? Math.round((Date.parse(`${state.date}T00:00:00Z`) - Date.parse(`${trackDate(summary.generatedAt, 0)}T00:00:00Z`)) / 86_400_000) : -1;
  const coverage = provider?.dailyCoverage30d[index];
  useEffect(() => {
    const frame = requestAnimationFrame(() => heading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [state.provider, state.date]);
  const gridState = { ...state, view: 'grid' as const, provider: '', date: '' };
  const componentNames = new Map(detail?.componentGroups.flatMap((group) => group.components.map((component) => [component.id, component.name] as const)));
  return <section className="day-view">
    <a className="day-back" href={serializeViewState(gridState) || './'} onClick={(event) => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); change(gridState);
    }}>返回矩阵</a>
    <div className="section-heading"><div><span className="eyebrow">DAILY SIGNAL / 每日聚合</span>
      <h1 tabIndex={-1} ref={heading}>{provider?.name ?? '未知厂商'} <span className="day-title-date">{validDate ? state.date : '日期无效'}</span></h1>
    </div><span className="mono muted">UTC / 1 DAY</span></div>
    <div className="day-snapshot"><time dateTime={summary.generatedAt}>快照 {timeLabel(summary.generatedAt)}</time><span>数据年龄 {ageLabel(summary.generatedAt, now)} · 每 {summary.intervalMinutes} 分钟采集</span></div>
    {summary.dataMode === 'fixture' && <div className="fixture-banner"><b>FIXTURE / 演示数据</b><span>独立预览环境 · 不代表厂商当前状态</span></div>}
    {!provider ? <StateNotice title="未知厂商" tone="warning">当前快照没有此厂商，请返回矩阵选择。</StateNotice>
      : !validDate ? <StateNotice title="日期无效" tone="warning">请使用有效的 YYYY-MM-DD UTC 日历日期。</StateNotice>
        : !inWindow ? <StateNotice title="日期不在当前 30 天轨迹窗口" tone="warning">
          当前窗口 {trackDate(summary.generatedAt, 0)} — {trackDate(summary.generatedAt, 29)} UTC。
          <a className="day-archive" href={serializeViewState({ ...state, view: 'incidents', provider: '', date: '', range: 'month', month: state.date.slice(0, 7), providers: [provider.id], severity: [] })}
            onClick={(event) => {
              if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault(); change({ view: 'incidents', provider: '', date: '', range: 'month', month: state.date.slice(0, 7), providers: [provider.id], severity: [] });
            }}>查看此厂商月度归档 →</a>
        </StateNotice> : <>
          <div className="day-summary"><span className={`day-status day-${provider.dailyTrack30d[index]}`}>{dayLabels[provider.dailyTrack30d[index]!]}</span>
            <span>UTC 日界 00:00 — 24:00 · 快照观测上限 {timeLabel(summary.generatedAt)}</span>
            <a href={provider.officialStatusUrl} target="_blank" rel="noopener noreferrer">官方状态 ↗</a></div>
          {snapshotExpired && <StateNotice title="快照过期 · 当前状态不可验证" tone="warning">数据年龄 {ageLabel(summary.generatedAt, now)}；保留的历史记录仅代表快照时点。</StateNotice>}
          {(coverage!.unknownMinutes > 0 || provider.coverage.currentState !== 'complete' || provider.coverage.limitation) && <StateNotice title="覆盖有限 · 未观测时间不计为正常" tone="warning">
            未知 {minutes(coverage!.unknownMinutes)}。{provider.coverage.limitation ?? '仅代表公开源与已配置范围内的信号。'}
          </StateNotice>}
          <dl className="day-metrics">
            <div><dt>已观测</dt><dd>{minutes(coverage!.observedCoverageMinutes)}</dd></div>
            <div><dt>未知</dt><dd>{minutes(coverage!.unknownMinutes)}</dd></div>
            <div><dt>官方影响</dt><dd>{day ? minutes(day.reportedImpactMinutes) : '等待日统计'}</dd></div>
            <div><dt>观测影响（估计）</dt><dd>{day ? minutes(day.observedImpactMinutes) : '等待日统计'}</dd></div>
          </dl>
          {detailError ? <StateNotice title="每日统计加载失败" tone="error" retry={retryDetail}>{detailError}</StateNotice>
            : !detail ? <StateNotice title="正在加载每日统计…" />
              : !day ? <StateNotice title="此日期暂无可信日统计" tone="warning" />
                : <p className="history-caption">影响分钟来自当日日统计，跨日事件不累计完整持续时长。{day.hasEstimatedTimes && '本日包含估计时间。'} 日统计记录 {day.incidentCount} 条；以下列表按 UTC 日区间关联所有事件类型。</p>}
          <section className="day-events" aria-label="当天相关事件">
            <div className="section-heading"><h2>当天相关事件</h2><span className="mono muted">{events?.length ?? '—'} EVENTS</span></div>
            {history.error ? <StateNotice title="每日事件加载失败" tone="error" retry={history.retry}>{history.error}</StateNotice>
              : events === null ? <StateNotice title="正在加载已记录事件…" />
                : !events.length ? <StateNotice title="暂无已记录事件">{['2', '3', '4'].includes(provider.dailyTrack30d[index]!) ? '轨迹记录了异常，但事件详情有限。' : ''}空记录不能证明当日正常，请同时参考覆盖分钟。</StateNotice>
                  : <>
                    <div className="day-impact"><h3>已记录影响范围</h3>
                      <p>组件：{[...new Set(events.flatMap(({ affectedComponentIds }) => affectedComponentIds))].map((id) => componentNames.get(id) ?? id).join(' / ') || '来源未提供'}</p>
                      <p>地域：{[...new Set(events.flatMap(({ affectedRegions }) => affectedRegions))].join(' / ') || '来源未提供'}</p>
                      <small>仅展示关联名称或标识，不代表组件当日的独立状态。</small></div>
                    <IncidentTimeline incidents={events} providerNames={{ [provider.id]: provider.name }} />
                  </>}
          </section>
        </>}
  </section>;
}
