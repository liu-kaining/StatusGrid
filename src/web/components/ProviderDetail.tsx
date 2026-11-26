import { useEffect, useRef, useState } from 'react';
import type { Manifest, ProviderDetail as Detail, ProviderSummary } from '../../shared/contracts.js';
import { ageLabel, statusLabels, statusSymbols, timeLabel } from '../data/queries.js';
import { DataAccess } from './DataAccess.js';
import { HealthTrack } from './HealthTrack.js';
import { IncidentTimeline } from './IncidentTimeline.js';
import { StateNotice } from './StateNotice.js';

export function ProviderDetail({ provider, detail, error, close, retry, restoreFocus, manifest, snapshotExpired, now }: {
  provider?: ProviderSummary; detail: Detail | null; error: string; close: () => void; retry: () => void;
  restoreFocus: () => void; manifest?: Manifest | null; snapshotExpired: boolean; now: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const restoreRef = useRef(restoreFocus); restoreRef.current = restoreFocus;
  const [componentQuery, setComponentQuery] = useState('');
  const [limit, setLimit] = useState(80);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const focusable = [...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, summary, [tabindex="0"]') ?? []]
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKey); restoreRef.current(); };
  }, []);
  const components = detail?.componentGroups.flatMap((group) => group.components.map((component) => ({ ...component, group: group.name }))) ?? [];
  const matches = components.filter((component) => !componentQuery || `${component.name} ${component.region ?? ''} ${component.group}`.toLocaleLowerCase().includes(componentQuery.toLocaleLowerCase()))
    .sort((a, b) => Number(b.reportedStatus !== 'operational') - Number(a.reportedStatus !== 'operational'));
  const visible = matches.slice(0, limit);
  const groups = new Map<string, typeof visible>();
  for (const component of visible) {
    const group = groups.get(component.group) ?? [];
    group.push(component); groups.set(component.group, group);
  }
  const unverified = snapshotExpired || detail?.provider.status === 'stale';
  const activeIds = new Set(detail?.provider.activeIncidents.map(({ id }) => id));
  const active = detail?.recentIncidents.filter(({ id }) => activeIds.has(id)) ?? [];
  const otherIncidents = detail?.recentIncidents.filter(({ id }) => !activeIds.has(id)) ?? [];
  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div className="detail-panel" role="dialog" aria-modal="true" aria-labelledby="detail-title" ref={panel} tabIndex={-1}>
      <div className="detail-header"><div><span className="eyebrow">PROVIDER / 厂商详情</span><h2 id="detail-title">{provider?.name ?? '未知厂商'}</h2></div><button className="icon-button" aria-label="关闭详情" onClick={close}>×</button></div>
      {error ? <StateNotice title="详情加载失败" tone="error" retry={retry}>{error}</StateNotice>
        : !detail ? <StateNotice title="正在加载厂商详情…" />
          : <div className="detail-body">
            <div className={`detail-status status-${snapshotExpired ? 'stale' : detail.provider.status}`}><span className="status-badge">{statusSymbols[snapshotExpired ? 'stale' : detail.provider.status]} {snapshotExpired ? '快照过期' : statusLabels[detail.provider.status]}</span>
              <a href={detail.provider.officialStatusUrl} target="_blank" rel="noopener noreferrer">官方状态 ↗</a></div>
            <p className="detail-checked">最近可信采集 <time>{timeLabel(detail.provider.collection.lastSuccessAt)}</time></p>
            {snapshotExpired && <StateNotice title="详情快照已过期 · 当前状态不可验证" tone="warning">数据年龄 {ageLabel(detail.generatedAt, now)}。上次可信状态：{detail.provider.reportedStatus ? statusLabels[detail.provider.reportedStatus] : '未知'}。以下组件与事件仅供历史参考。</StateNotice>}
            {detail.provider.status === 'stale' && <StateNotice title="采集受阻 · 服务状态不可验证" tone="warning">{detail.provider.collection.message ?? '当前没有新鲜可信的数据，不代表厂商服务中断。'}</StateNotice>}
            {detail.warnings.length > 0 && <div className="detail-warnings">{detail.warnings.map((warning, index) => <p key={index}>△ {warning}</p>)}</div>}
            <section className="detail-section"><h3>近 30 天 <span>DAILY SIGNAL</span></h3><HealthTrack provider={detail.provider} generatedAt={detail.generatedAt} />
              <p className="muted small">底部纹理标记未观测分钟；未知时段不计为正常。轨迹按快照 UTC 日期对齐。</p>
              <details className="daily-history"><summary>每日覆盖与影响分钟</summary><div className="table-scroll"><table><thead><tr><th>日期 UTC</th><th>已观测</th><th>未知</th><th>官方影响</th><th>观测影响</th></tr></thead><tbody>
                {[...detail.dailyHistory30d].reverse().map((day) => <tr key={day.date}><th>{day.date}</th><td>{Math.round(day.observedCoverageMinutes)}</td><td>{Math.round(day.unknownMinutes)}</td>
                  <td>{day.reportedImpactMinutes === null ? '—' : Math.round(day.reportedImpactMinutes)}</td><td>{day.observedImpactMinutes === null ? '—' : `≈ ${Math.round(day.observedImpactMinutes)}`}</td></tr>)}
              </tbody></table></div></details>
            </section>
            <section className="detail-section"><h3>组件状态 <span>{components.length} COMPONENTS</span></h3>
              {components.length > 0 ? <><label className="component-search">筛选组件 / 地域<input type="search" value={componentQuery} onChange={(event) => { setComponentQuery(event.target.value); setLimit(80); }} /></label>
                <p className="muted small">显示 {visible.length} / {matches.length} 个匹配组件 · 异常优先</p>
                {[...groups].map(([group, values]) => <details className="component-group" open key={group}><summary>{group} <span>{values.length}</span></summary><ul>{values.map((component) =>
                  <li key={component.id} data-testid="component-row"><div>{component.name}<small>{component.region ?? '未指定地域'}</small></div><span className={`component-state status-${unverified ? 'stale' : component.reportedStatus ?? 'stale'}`}>{statusSymbols[unverified ? 'stale' : component.reportedStatus ?? 'stale']} {unverified ? '上次：' : ''}{component.reportedStatus ? statusLabels[component.reportedStatus] : '状态未知'}</span></li>)}</ul></details>)}
                {matches.length > limit && <button className="quiet-button" onClick={() => setLimit((value) => value + 80)}>再显示 80 个组件</button>}
                {!matches.length && <p className="muted">没有匹配的组件</p>}</> : <p className="muted">此来源没有可信组件清单。</p>}
            </section>
            <section className="detail-section"><h3>{unverified ? '快照内活跃事件' : '当前活跃事件'} <span>{active.length} ACTIVE</span></h3>
              {active.length ? <IncidentTimeline incidents={active} /> : <p className="muted">{unverified ? '可信记录中暂无可核实的活跃故障。' : '官方未报告活跃故障。'}</p>}</section>
            <section className="detail-section"><h3>近期事件与维护 <span>INCIDENT LOG</span></h3>
              {otherIncidents.length ? <IncidentTimeline incidents={otherIncidents} /> : <p className="muted">覆盖范围内暂无其他近期事件记录。</p>}</section>
            <section className="detail-section coverage-section"><h3>覆盖范围与来源 <span>SOURCE SCOPE</span></h3><dl>
              <div><dt>配置地域子集</dt><dd>{detail.provider.coverage.regions.join(' / ') || '公开源未限定地域'}</dd></div>
              <div><dt>组件范围</dt><dd>{detail.provider.coverage.componentScope === 'full' ? '完整公开清单' : detail.provider.coverage.componentScope === 'filtered' ? '配置筛选子集' : '仅事件覆盖'}</dd></div>
              <div><dt>当前覆盖</dt><dd>{detail.provider.coverage.currentState === 'complete' ? '公开范围完整' : detail.provider.coverage.currentState === 'partial' ? '部分覆盖' : '不可用'}</dd></div>
              <div><dt>历史来源</dt><dd>{detail.provider.coverage.history}</dd></div><div><dt>开始观测</dt><dd>{timeLabel(detail.provider.coverage.observedSince)}</dd></div>
            </dl>{detail.provider.coverage.limitation && <p className="coverage-limitation">△ {detail.provider.coverage.limitation}</p>}<p className="muted small">官方公开信号仅反映其声明的地域、产品与观测范围，不代表全量用户可用性。</p></section>
            <DataAccess provider={detail.provider.id} manifest={manifest} />
          </div>}
    </div>
  </div>;
}
