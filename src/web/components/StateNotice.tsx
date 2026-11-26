import type { ReactNode } from 'react';

export function StateNotice({ title, children, tone = 'neutral', retry }: {
  title: string; children?: ReactNode; tone?: 'neutral' | 'warning' | 'error'; retry?: () => void;
}) {
  return <section className={`state-notice notice-${tone}`} role={tone === 'neutral' ? 'status' : 'alert'}>
    <span className="notice-symbol" aria-hidden="true">{tone === 'neutral' ? '◌' : '!'}</span>
    <div><p className="notice-title">{title}</p>{children && <div className="notice-body">{children}</div>}</div>
    {retry && <button className="quiet-button" onClick={retry}>重试</button>}
  </section>;
}
