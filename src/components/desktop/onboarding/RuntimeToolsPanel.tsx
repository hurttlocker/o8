'use client';

import { useState, type CSSProperties } from 'react';
import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { getRuntimeInstallInfo } from '@/lib/setup/runtime-install';

const quietButton: CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--t-text-secondary)',
  fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300,
  paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8,
  cursor: 'pointer', textAlign: 'left',
};

export function RuntimeToolsPanel({ inventory, loading, error, onRefresh, initiallyExpanded = false }: {
  initiallyExpanded?: boolean;
  inventory: readonly SetupRuntime[] | null; loading: boolean; error?: string | null; onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const needsSetup = inventory?.filter((item) => !item.available) ?? [];
  return (
    <div style={{ fontFamily: 'var(--font-sans-system)', fontSize: 11, color: 'var(--t-text-muted)' }}>
      {error ? <div role="alert" style={{ padding: 8, color: 'var(--t-brand-red)' }}>{error}</div> : null}
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary style={{ ...quietButton, display: 'list-item', marginLeft: 8 }}>Add tools</summary>
        <div style={{ maxHeight: 240, overflowY: 'auto', paddingLeft: 8, paddingRight: 8 }}>
          <p style={{ lineHeight: 1.4 }}>Install or connect a tool, then refresh. New tools become available without changing your setup.</p>
          {needsSetup.map((item) => {
            const info = getRuntimeInstallInfo(item.id);
            const command = item.unavailableReason === 'not_installed' ? info?.command : undefined;
            return (
              <div key={item.id} style={{ paddingTop: 8, paddingBottom: 8, borderTop: '1px solid var(--t-border)' }}>
                <div style={{ color: 'var(--t-text)', fontSize: 13, fontWeight: 300 }}>{item.label}</div>
                <div style={{ lineHeight: 1.45, marginTop: 4, overflowWrap: 'anywhere' }}>{item.fix || info?.hint || item.detail}</div>
                {command ? <button type="button" style={quietButton} onClick={async () => {
                  try { await navigator.clipboard.writeText(command); setCopied(item.id); setCopyError(false); }
                  catch { setCopyError(true); }
                }}>{copied === item.id ? 'Copied install command' : 'Copy install command'}</button> : null}
                {info?.link ? <a href={info.link} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--t-accent)', display: 'inline-block', marginTop: 5 }}>Setup instructions</a> : null}
              </div>
            );
          })}
          {inventory && inventory.length > 0 && needsSetup.length === 0 ? <p>All supported tools in this inventory are ready.</p> : null}
          {inventory?.length === 0 ? <p>No tool inventory was returned. Refresh to try again.</p> : null}
          {copyError ? <p role="alert">Clipboard unavailable. Use the tool’s installation instructions.</p> : null}
        </div>
      </details>
      <button type="button" disabled={loading} onClick={onRefresh} style={{ ...quietButton, opacity: loading ? 0.6 : 1 }}>
        {loading ? 'Checking installed tools and sign-in…' : 'Refresh tools'}
      </button>
    </div>
  );
}
