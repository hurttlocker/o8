'use client';

// Throwaway dev harness to iterate WorkspaceBootLoader in both themes without
// rebooting the app. Sets the theme tokens the loader reads, then remounts it.
import { useEffect, useState, type CSSProperties } from 'react';
import { WorkspaceBootLoader } from '@/components/desktop/workspace-terminal/WorkspaceBootLoader';

const THEMES: Record<string, Record<string, string>> = {
  dark: { '--t-chat-surface-bg': '#0a0a0a', '--t-text': '#f4f4f5', '--t-text-faint': 'rgba(244,244,245,0.4)' },
  light: { '--t-chat-surface-bg': '#f4f2ed', '--t-text': '#111111', '--t-text-faint': 'rgba(17,17,17,0.42)' },
};

export default function BootLoaderPreview() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const vars = THEMES[theme];
    for (const k in vars) document.documentElement.style.setProperty(k, vars[k]);
    document.documentElement.style.setProperty('--font-sans-system', 'system-ui, -apple-system, sans-serif');
  }, [theme]);

  const btn: CSSProperties = {
    padding: '6px 12px',
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid #8884',
    background: '#8882',
    color: 'inherit',
    cursor: 'pointer',
  };

  return (
    <>
      <div style={{ position: 'fixed', top: 12, left: 12, zIndex: 300, display: 'flex', gap: 8 }}>
        <button type="button" style={btn} onClick={() => setTheme('dark')}>
          dark
        </button>
        <button type="button" style={btn} onClick={() => setTheme('light')}>
          light
        </button>
      </div>
      <WorkspaceBootLoader key={theme} />
    </>
  );
}
