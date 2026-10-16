'use client';

import type { CliUpdateRecord } from '@/lib/setup/cli-updates';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { ProviderMarkGlyph } from '../thoughts/composer-selector/provider-marks';

/** Versions are secondary; the update state stays easy to scan. */
export function ConnectedCliUpdateRows({ tools, busy, disabled = false, onUpdate }: { tools: CliUpdateRecord[]; busy: string | null; disabled?: boolean; onUpdate?: (runtime: 'codex' | 'claude-code' | 'grok') => void }) {
  return <div style={{ display: 'grid', gap: 10 }}>
    {tools.map(tool => <div key={tool.runtimeId} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <span aria-hidden="true" style={{ width: 16, height: 16, display: 'inline-flex', flexShrink: 0 }}>
        <ProviderMarkGlyph mark={tool.runtimeId === 'codex' ? 'openai' : tool.runtimeId === 'claude-code' ? 'anthropic' : tool.runtimeId === 'grok' ? 'x' : 'gemini'} size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5 }}>{tool.label}</div>
        <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--t-text-muted)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
          {tool.installedVersion ?? 'Version unavailable'}{tool.status === 'update-available' && tool.latestVersion ? ` → ${tool.latestVersion}` : ''}
        </div>
        {tool.runtimeId === 'grok' && tool.manager === 'npm' && tool.status === 'update-available' ? <button type="button"
          onClick={() => openExternalUrl(tool.updateUrl)} style={{ border: 0, padding: 0, marginTop: 3, background: 'transparent',
            color: 'var(--t-text-secondary)', font: 'inherit', fontSize: 10.5, cursor: 'pointer', textDecoration: 'underline' }}>Open original updater</button> : null}
      </div>
      {onUpdate && tool.status === 'update-available' && (tool.runtimeId === 'codex' || tool.runtimeId === 'claude-code' || tool.runtimeId === 'grok') ? <button type="button"
        aria-label={`Update ${tool.label}`} disabled={disabled} onClick={() => onUpdate(tool.runtimeId as 'codex' | 'claude-code' | 'grok')}
        style={{ flexShrink: 0, height: 26, borderRadius: 7, border: 0, paddingTop: 0, paddingBottom: 0, paddingLeft: 8, paddingRight: 8, font: 'inherit', fontSize: 11, fontWeight: 300,
          color: 'var(--t-text)', background: 'var(--t-hover)', cursor: disabled ? 'wait' : 'pointer' }}>
        {busy === tool.runtimeId ? 'Updating…' : 'Update'}
      </button> : <span style={{ flexShrink: 0, fontSize: 10.5, color: tool.status === 'update-available' ? 'var(--t-accent)' : 'var(--t-text-muted)' }}>
        {busy === tool.runtimeId ? 'Updating…' : tool.status === 'current' ? 'Current' : tool.status === 'update-available' ? 'Ready' : 'Check again'}
      </span>}
    </div>)}
  </div>;
}
