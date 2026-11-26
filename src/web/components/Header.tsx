import type { ViewState } from '../state/types.js';

export function Header({ view, navigate, theme, toggleTheme }: {
  view: ViewState['view']; navigate: (view: ViewState['view']) => void; theme: 'dark' | 'light'; toggleTheme: () => void;
}) {
  return <header className="site-header">
    <a className="brand" href="./" aria-label="StatusGrid 首页"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span>StatusGrid<small>PUBLIC STATUS OBSERVATORY</small></span></a>
    <nav className="view-tabs" aria-label="主视图">
      <button aria-current={view === 'grid' ? 'page' : undefined} onClick={() => navigate('grid')}><span className="nav-dot" />Live Grid <span className="tab-cn">实时矩阵</span></button>
      <button aria-current={view === 'incidents' ? 'page' : undefined} onClick={() => navigate('incidents')}>Incident Vault <span className="tab-cn">事件档案</span></button>
    </nav>
    <div className="header-actions">
      <a href="#data-access">开放数据 <span aria-hidden="true">↗</span></a>
      <a href="https://github.com/liu-kaining/StatusGrid" target="_blank" rel="noopener noreferrer">源码 <span aria-hidden="true">↗</span></a>
      <button className="icon-button" onClick={toggleTheme} aria-label={`切换到${theme === 'dark' ? '浅' : '深'}色主题`}>{theme === 'dark' ? '☼' : '◐'}</button>
    </div>
  </header>;
}
