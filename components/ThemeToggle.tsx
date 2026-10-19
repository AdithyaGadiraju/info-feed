'use client';

import { useEffect, useState } from 'react';
import Icon from '@/components/Icon';

type Theme = 'light' | 'dark';

/**
 * Opt-in dark mode. The layout's head script applies the saved choice before
 * paint; this button only flips it and remembers it. localStorage can throw in
 * private modes, so a failed save just means the choice lasts for this page.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {}
    setTheme(next);
  };

  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button type="button" className="btn btn-ghost" onClick={toggle} aria-label={label} title={label}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
    </button>
  );
}
