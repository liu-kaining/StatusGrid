import type { ProviderSummary } from '../../shared/contracts.js';
import { useEffect, useId, useRef, useState } from 'react';
import { trackDate } from '../data/queries.js';
import type { ViewState } from '../state/types.js';
import { parseViewState, serializeViewState } from '../state/url.js';
import { DayPopover } from './DayPopover.js';

export const dayLabels: Record<string, string> = { '0': '运行正常', '1': '维护', '2': '性能下降', '3': '部分中断', '4': '严重中断', '9': '数据不足' };
export interface DayNavigation {
  snapshotId?: string;
  viewState?: ViewState;
  openDay?: (provider: string, date: string) => void;
}
export function HealthTrack({ provider, generatedAt, snapshotId = '', viewState, openDay }: {
  provider: ProviderSummary; generatedAt: string;
} & DayNavigation) {
  const [active, setActive] = useState(29);
  const [hover, setHover] = useState<{ index: number; anchor: HTMLAnchorElement } | null>(null);
  const links = useRef<(HTMLAnchorElement | null)[]>([]);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepOpen = () => clearTimeout(closeTimer.current);
  const closeSoon = () => { keepOpen(); closeTimer.current = setTimeout(() => setHover(null), 150); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const popoverOpen = hover !== null;
  useEffect(() => {
    if (!popoverOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); setHover(null);
    };
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [popoverOpen]);
  const id = useId();
  const labelAt = (index: number) => {
    const coverage = provider.dailyCoverage30d[index]!;
    return `${trackDate(generatedAt, index)} UTC · ${dayLabels[provider.dailyTrack30d[index]!]} · 已观测 ${Math.round(coverage.observedCoverageMinutes)} 分钟 / 未知 ${Math.round(coverage.unknownMinutes)} 分钟`;
  };
  return <div className="health-track-wrap"><div className="health-track" role="group" aria-label={`${provider.name} 近 30 天状态轨迹；底部纹理表示存在未观测时间`}
    onMouseLeave={closeSoon} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHover(null); }}>
    {[...provider.dailyTrack30d].map((status, index) => {
      const coverage = provider.dailyCoverage30d[index]!;
      const date = trackDate(generatedAt, index);
      return <a key={index} ref={(node) => { links.current[index] = node; }} className={`track-day day-${status}${coverage.unknownMinutes > 0 ? ' has-unknown' : ''}`}
        href={serializeViewState({ ...viewState ?? parseViewState(''), view: 'day', provider: provider.id, date })}
        tabIndex={active === index ? 0 : -1} aria-label={`${provider.name} · ${labelAt(index)}`} aria-describedby={hover?.index === index ? id : undefined}
        data-day-provider={provider.id} data-day-date={date}
        onMouseEnter={(event) => { keepOpen(); setHover({ index, anchor: event.currentTarget }); }}
        onFocus={(event) => { keepOpen(); setActive(index); setHover({ index, anchor: event.currentTarget }); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && hover) { event.preventDefault(); event.stopPropagation(); setHover(null); return; }
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? 29 : event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'ArrowRight' ? Math.min(29, index + 1) : null;
          if (next !== null) { event.preventDefault(); links.current[next]?.focus(); }
        }}
        onClick={(event) => {
          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !openDay) return;
          event.preventDefault(); setHover(null); openDay(provider.id, date);
        }} />;
    })}
  </div><div className="track-axis"><span>30 DAYS AGO</span><span>UTC · TODAY</span></div>
    {hover && <DayPopover id={id} anchor={hover.anchor} provider={provider} date={trackDate(generatedAt, hover.index)}
      label={labelAt(hover.index)} snapshotId={snapshotId} generatedAt={generatedAt} keepOpen={keepOpen} closeSoon={closeSoon} />}
  </div>;
}
