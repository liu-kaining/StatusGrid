import type { Incident } from '../../shared/contracts.js';
import { statusLabels, timeLabel } from '../data/queries.js';

const phaseLabels: Record<Incident['state'], string> = { investigating: '调查中', identified: '已定位', monitoring: '监控中',
  resolved: '已恢复', scheduled: '已计划', in_progress: '进行中', completed: '已完成', unknown: '阶段未知' };
const kindLabels = { incident: '故障', maintenance: '维护', advisory: '建议' };
export function IncidentTimeline({ incidents, providerNames = {} }: { incidents: Incident[]; providerNames?: Record<string, string> }) {
  let previousDay = '';
  return <div className="incident-timeline">{incidents.map((incident) => {
    const day = incident.startedAt.slice(0, 10);
    const showDay = previousDay !== day;
    previousDay = day;
    return <div key={incident.id}>
      {showDay && <div className="timeline-day"><span>{day}</span><small>UTC</small></div>}
      <article className={`incident status-${incident.severity ?? 'stale'}`} data-testid="incident">
        <div className="incident-meta"><span>{providerNames[incident.providerId] ?? incident.providerId}</span><span>{kindLabels[incident.kind]}</span>
          <span>{incident.origin === 'official' ? '官方事件' : '观测事件 · 估计时间'}</span><span>{phaseLabels[incident.state]}</span></div>
        <h3>{incident.title}</h3>
        <div className="incident-time"><span>{incident.severity ? statusLabels[incident.severity] : '严重度未知'}</span><time>{timeLabel(incident.startedAt)}</time>
          {incident.resolvedAt && <span>恢复于 {timeLabel(incident.resolvedAt)}</span>}</div>
        {incident.affectedRegions.length > 0 && <p className="muted">地域：{incident.affectedRegions.join(' / ')}</p>}
        <div className="incident-links"><a href={incident.sourceUrl} target="_blank" rel="noopener noreferrer">官方事件 ↗</a>
          {incident.postmortemUrl && <a href={incident.postmortemUrl} target="_blank" rel="noopener noreferrer">官方复盘 ↗</a>}</div>
        {incident.updates.length > 0 && <details className="incident-updates"><summary>事件更新 <span>{incident.updates.length}</span></summary>
          <ol>{[...incident.updates].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((update) =>
            <li key={update.id}><div><b>{phaseLabels[update.phase]}</b><time>{timeLabel(update.timestamp)}</time></div><p>{update.body}</p></li>)}</ol></details>}
      </article>
    </div>;
  })}</div>;
}
