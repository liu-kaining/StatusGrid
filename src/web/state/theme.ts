import { useState } from 'react';

export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('statusgrid-theme'); } catch { /* Storage can be unavailable in private contexts. */ }
    const initial = saved === 'light' ? 'light' : saved === 'dark' ? 'dark'
      : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = initial;
    return initial;
  });
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('statusgrid-theme', next); } catch { /* The current session theme still works. */ }
  };
  return { theme, toggle };
}
