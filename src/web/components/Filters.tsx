import type { RefObject } from 'react';
import type { Category } from '../../shared/contracts.js';
import { categoryLabels } from '../data/queries.js';
import type { ViewState } from '../state/types.js';

export function Filters({ state, change, inputRef, searchStatus }: {
  state: ViewState; change: (patch: Partial<ViewState>, replace?: boolean) => void;
  inputRef: RefObject<HTMLInputElement | null>; searchStatus: 'loading' | 'ready' | 'error';
}) {
  return <section className="filter-panel" aria-label="筛选厂商">
    <div className="search-field"><span aria-hidden="true">⌕</span><input ref={inputRef} type="search" aria-label="搜索厂商、组件、地域或事件" value={state.query}
      onChange={(event) => change({ query: event.target.value }, true)} placeholder="搜索厂商、组件、地域或事件…" /><kbd>/</kbd></div>
    <div className="filter-bottom"><div className="category-tabs" aria-label="厂商分类">
      <button aria-pressed={!state.category} onClick={() => change({ category: '' })}>全部</button>
      {(Object.entries(categoryLabels) as [Category, string][]).map(([category, label]) =>
        <button key={category} aria-pressed={state.category === category} onClick={() => change({ category })}>{label}</button>)}
    </div><label className="abnormal-toggle"><input type="checkbox" checked={state.onlyAbnormal} onChange={(event) => change({ onlyAbnormal: event.target.checked })} />仅看异常与受阻</label></div>
    {state.query && searchStatus === 'loading' && <p className="search-notice" role="status">搜索索引加载中；暂按厂商名称搜索…</p>}
    {searchStatus === 'error' && <p className="search-notice warning" role="alert">搜索索引不可用；当前仅搜索厂商名称。分类和异常筛选仍可使用。</p>}
  </section>;
}
