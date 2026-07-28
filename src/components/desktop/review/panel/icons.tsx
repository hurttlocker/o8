import { MONO_FONT } from './constants';

// ── icons (raw SVG — React icon components don't render in the Tauri webview) ──

function IconSearch({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function IconFilesDrawer({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M3 7.5h6l2 2h10" />
      <path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13A2.5 2.5 0 0 0 21 17.5v-8" />
      <path d="M7 4h10a2 2 0 0 1 2 2v3.5" />
    </svg>
  );
}

function IconScopeFilter({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <circle cx="16" cy="7" r="2" />
      <path d="M4 17h2" />
      <path d="M10 17h10" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  );
}

function IconSplit({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </svg>
  );
}

function IconUnified({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

// Vertical sliders — the diff toolbar's "View options" trigger. Deliberately
// vertical so it never reads as IconScopeFilter (horizontal sliders) two
// buttons over.
function IconViewOptions({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M5 21v-6M5 11V3" />
      <path d="M12 21v-9M12 8V3" />
      <path d="M19 21v-4M19 13V3" />
      <path d="M3 13h4M10 10h4M17 15h4" />
    </svg>
  );
}

function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DiffStatBadge({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO_FONT, fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
      {additions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-green, #16a34a)' }}>+{additions}</span> : null}
      {deletions > 0 ? <span style={{ color: 'var(--t-terminal-ansi-bright-red, #ef4444)' }}>-{deletions}</span> : null}
      {additions === 0 && deletions === 0 ? <span style={{ color: 'var(--t-text-faint)' }}>0</span> : null}
    </span>
  );
}

export {
  IconSearch,
  IconFilesDrawer,
  IconScopeFilter,
  IconSplit,
  IconUnified,
  IconViewOptions,
  IconCheck,
  DiffStatBadge,
};
