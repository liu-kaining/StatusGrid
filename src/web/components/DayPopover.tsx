import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProviderSummary } from '../../shared/contracts.js';
import { incidentsForDay } from '../data/day.js';
import { useDayHistory } from '../data/use-day-history.js';

export function DayPopover({ id, anchor, provider, date, label, snapshotId, generatedAt, keepOpen, closeSoon }: {
  id: string; anchor: HTMLElement; provider: ProviderSummary; date: string; label: string; snapshotId: string; generatedAt: string;
  keepOpen: () => void; closeSoon: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const history = useDayHistory(snapshotId);
  const events = history.incidents === null ? null : incidentsForDay(history.incidents, provider.id, date, generatedAt);
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const box = panel.current!.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8)),
        top: Math.max(8, Math.min(rect.top - box.height - 10 >= 8 ? rect.top - box.height - 10 : rect.bottom + 10, window.innerHeight - box.height - 8)),
      });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, events?.length, history.error]);
  return createPortal(<div ref={panel} id={id} role="tooltip" className="day-popover" style={position} onMouseEnter={keepOpen} onMouseLeave={closeSoon}>
    <div className="day-popover-heading"><b>{provider.name}</b><span>DAILY SIGNAL</span></div>
    <p>{label}</p>
    {history.error ? <p className="day-popover-warning">事件加载失败 · 进入每日详情后可重试</p>
      : events === null ? <p className="muted">正在加载已记录事件…</p>
        : <><p className="day-popover-count">{events.length} 条已记录事件</p>
          {events.length ? <ul>{events.slice(0, 3).map((event) => <li key={event.id}>{event.title}</li>)}</ul> : <p className="muted">暂无已记录事件，不代表当日正常。</p>}
          {events.length > 3 && <p className="muted">另有 {events.length - 3} 条 · 进入每日详情查看</p>}</>}
    <div className="day-popover-footer">点击 / Enter 查看每日详情 →</div>
  </div>, document.body);
}
