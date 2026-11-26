import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderDetail as Detail, SearchIndex, Summary } from '../shared/contracts.js';
import { dataClient, SnapshotChangedError } from './data/client.js';
import { ageLabel, filterProviders, snapshotFreshness } from './data/queries.js';
import { parseViewState, serializeViewState } from './state/url.js';
import type { ViewState } from './state/types.js';
import { useTheme } from './state/theme.js';
import { Header } from './components/Header.js';
import { Overview } from './components/Overview.js';
import { Filters } from './components/Filters.js';
import { ProviderCard } from './components/ProviderCard.js';
import { ProviderDetail } from './components/ProviderDetail.js';
import { HistoryView } from './components/HistoryView.js';
import { DataAccess } from './components/DataAccess.js';
import { StateNotice } from './components/StateNotice.js';
import { DayView } from './components/DayView.js';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/components.css';

export function App() {
  const [state, setState] = useState(() => parseViewState(location.search));
  const stateRef = useRef(state);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [refreshError, setRefreshError] = useState('');
  const [refreshing, setRefreshing] = useState(true);
  const [now, setNow] = useState(Date.now);
  const [search, setSearch] = useState<SearchIndex | null>(null);
  const [searchStatus, setSearchStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailAttempt, setDetailAttempt] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const dayTrigger = useRef<{ provider: string; date: string } | null>(null);
  const urlTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshController = useRef<AbortController | null>(null);
  const { theme, toggle } = useTheme();

  const change = useCallback((patch: Partial<ViewState>, replace = false) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next; setState(next);
    clearTimeout(urlTimer.current);
    const save = () => {
      const url = `${location.pathname}${serializeViewState(next)}${location.hash}`;
      if (`${location.pathname}${location.search}${location.hash}` !== url) history[replace ? 'replaceState' : 'pushState']({}, '', url);
    };
    if (replace) urlTimer.current = setTimeout(save, 250);
    else save();
  }, []);
  const openDay = useCallback((provider: string, date: string) => {
    dayTrigger.current = { provider, date };
    change({ view: 'day', provider, date });
  }, [change]);
  useEffect(() => {
    if (state.view === 'day') { dayTrigger.current = { provider: state.provider, date: state.date }; return; }
    if (state.view !== 'grid' || state.provider || !dayTrigger.current) return;
    const target = dayTrigger.current;
    const frame = requestAnimationFrame(() => {
      const cell = document.querySelector<HTMLElement>(`[data-day-provider="${target.provider}"][data-day-date="${target.date}"]`);
      (cell ?? searchInput.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state.view, state.provider, state.date]);
  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    setRefreshing(true);
    try {
      const value = await dataClient.loadSnapshot(controller.signal);
      if (controller.signal.aborted) return;
      setSummary((previous) => previous?.snapshotId === value.snapshotId ? previous : value);
      setRefreshError(''); setNow(Date.now());
    } catch (reason) {
      if (!controller.signal.aborted) setRefreshError(reason instanceof Error ? reason.message : '未知请求错误');
    } finally { if (!controller.signal.aborted) setRefreshing(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const tick = () => { setNow(Date.now()); if (!document.hidden) void refresh(); };
    const timer = setInterval(tick, 60_000);
    const visibility = () => { if (!document.hidden) tick(); };
    const popstate = () => {
      clearTimeout(urlTimer.current);
      const value = parseViewState(location.search); stateRef.current = value; setState(value);
    };
    window.addEventListener('popstate', popstate);
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); clearTimeout(urlTimer.current); refreshController.current?.abort();
      window.removeEventListener('popstate', popstate); document.removeEventListener('visibilitychange', visibility); };
  }, [refresh]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (stateRef.current.provider) return;
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); searchInput.current?.focus(); }
      if (event.key === 'Escape' && document.activeElement === searchInput.current) { change({ query: '' }, true); searchInput.current?.blur(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [change]);
  useEffect(() => {
    if (!summary) return;
    const controller = new AbortController();
    setSearch(null); setSearchStatus('loading');
    const timer = setTimeout(() => {
      dataClient.loadSearch(summary.snapshotId, controller.signal).then((value) => {
        if (!controller.signal.aborted) { setSearch(value); setSearchStatus('ready'); }
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) { setSearchStatus('error'); if (reason instanceof SnapshotChangedError) void refresh(); }
      });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [summary, refresh]);
  useEffect(() => {
    setDetail(null); setDetailError('');
    if (!state.provider || !summary || !summary.providers.some(({ id }) => id === state.provider)) return;
    const controller = new AbortController();
    dataClient.loadProvider(state.provider, summary.snapshotId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setDetail(value);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setDetailError(reason instanceof Error ? reason.message : '未知请求错误');
      if (reason instanceof SnapshotChangedError) void refresh();
    });
    return () => controller.abort();
  }, [state.provider, summary, detailAttempt, refresh]);

  const snapshotExpired = summary ? snapshotFreshness(summary.generatedAt, summary.intervalMinutes, now) === 'stale' : false;
  const providers = summary ? filterProviders(summary.providers, state, search, snapshotExpired) : [];
  const groups = [
    { key: 'fault', title: '异常与维护', label: 'ATTENTION REQUIRED', values: snapshotExpired ? [] : providers.filter(({ status }) => status !== 'operational' && status !== 'stale') },
    { key: 'blocked', title: snapshotExpired ? '快照过期 · 当前状态不可验证' : '采集受阻', label: snapshotExpired ? 'HISTORICAL SNAPSHOT' : 'DATA UNVERIFIED · 不代表服务故障',
      values: snapshotExpired ? providers : providers.filter(({ status }) => status === 'stale') },
    { key: 'normal', title: '官方未报告异常', label: 'NO REPORTED ISSUES', values: snapshotExpired ? [] : providers.filter(({ status }) => status === 'operational') },
  ];
  const manifest = summary ? dataClient.getManifest(summary.snapshotId) : null;
  return <>
    <div inert={Boolean(state.view !== 'day' && state.provider && summary)} aria-hidden={state.view !== 'day' && state.provider && summary ? true : undefined}>
    <a href="#main-content" className="skip-link">跳转到主要内容</a>
    <Header view={state.view} navigate={(view) => change({ view, provider: '', date: '' })} theme={theme} toggleTheme={toggle} />
    <main id="main-content">
      {summary ? <>
        {state.view !== 'day' && <Overview summary={summary} now={now} refreshing={refreshing} refresh={() => void refresh()} />}
        {refreshError && <StateNotice title="刷新失败，保留上次可信快照" tone="warning" retry={() => void refresh()}>数据年龄 {ageLabel(summary.generatedAt, now)}。{refreshError}</StateNotice>}
        {state.view === 'grid' ? <>
          <Filters state={state} change={change} inputRef={searchInput} searchStatus={searchStatus} />
          <div className="matrix-caption"><span>PROVIDER MATRIX <b>{providers.length.toString().padStart(2, '0')}</b></span><span>{snapshotExpired ? '历史快照 · 当前状态不可验证' : '严重度优先 · 官方公开信号'}</span></div>
          {!providers.length && !(state.query && searchStatus === 'loading') && <StateNotice title="没有匹配的厂商">试试其他关键词或分类。</StateNotice>}
          {groups.map((group) => group.values.length > 0 && <section className={`matrix-section matrix-${group.key}`} key={group.key} aria-labelledby={`group-${group.key}`}>
            <div className="matrix-group-heading"><h2 id={`group-${group.key}`}>{group.title}<span>{group.values.length.toString().padStart(2, '0')}</span></h2><span>{group.label}</span></div>
            <div className="provider-grid">{group.values.map((provider) => <ProviderCard key={provider.id} provider={provider} generatedAt={summary.generatedAt} snapshotExpired={snapshotExpired}
              snapshotId={summary.snapshotId} viewState={state} openDay={openDay} refreshSnapshot={refresh}
              open={(id, trigger) => { detailTrigger.current = trigger; change({ provider: id }); }} />)}</div>
          </section>)}
          <div className="track-legend"><span><i className="day-0" />正常</span><span><i className="day-1" />维护</span><span><i className="day-2" />性能下降</span><span><i className="day-4" />服务中断</span><span><i className="day-9 has-unknown" />未知 / 部分未观测</span><span>30 天 UTC 轨迹 · 悬停查看覆盖分钟</span></div>
        </> : state.view === 'day' ? <DayView summary={summary} state={state}
          detail={detail?.snapshotId === summary.snapshotId && detail.provider.id === state.provider ? detail : null}
          detailError={detailError} retryDetail={() => setDetailAttempt((value) => value + 1)} change={change} snapshotExpired={snapshotExpired} now={now} refresh={refresh} />
          : <HistoryView summary={summary} state={state} change={change} refresh={refresh} />}
      </> : <div className="initial-state"><span className="eyebrow">STATUSGRID / PUBLIC SIGNALS</span><h1>服务状态观测台<span className="heading-period">.</span></h1>
        {refreshing ? <StateNotice title="正在读取已发布快照…" /> : <StateNotice title="尚无可用快照" tone="warning" retry={() => void refresh()}>请先运行采集与公开数据导出，再重新检查。{refreshError}</StateNotice>}</div>}
      <DataAccess manifest={manifest} />
      <footer className="site-footer"><span>StatusGrid <span className="muted">/ 独立公开状态聚合</span></span><span>状态来自厂商公开源，受覆盖范围与采集延迟限制。</span><span className="mono">UTC / SCHEMA 1.0</span></footer>
    </main>
    </div>
    {state.view !== 'day' && state.provider && summary && <ProviderDetail key={state.provider} provider={summary.providers.find(({ id }) => id === state.provider)}
      snapshotId={summary.snapshotId} viewState={state} openDay={openDay} refreshSnapshot={refresh}
      detail={detail?.snapshotId === summary.snapshotId && detail.provider.id === state.provider ? detail : null} error={detailError} snapshotExpired={snapshotExpired} now={now}
      close={() => change({ provider: '' })} retry={() => setDetailAttempt((value) => value + 1)} manifest={manifest}
      restoreFocus={() => { const trigger = detailTrigger.current; if (trigger?.isConnected) trigger.focus(); else searchInput.current?.focus(); }} />}
  </>;
}
