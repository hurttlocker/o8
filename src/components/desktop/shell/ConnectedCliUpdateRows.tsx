'use client';

import { useEffect, useState } from 'react';
import type { CliUpdateRecord } from '@/lib/setup/cli-updates';
import type { StableCli } from '@/lib/setup/cli-installation';
import type { CliUpdateProgress } from '@/lib/setup/cli-update-progress';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { ProviderMarkGlyph, type ProviderMark } from '../thoughts/composer-selector/provider-marks';

const marks: Record<string, ProviderMark> = { codex: 'openai', 'claude-code': 'anthropic', grok: 'x', gemini: 'gemini',
  opencode: 'opencode', antigravity: 'antigravity', cursor: 'cursor', pi: 'pi', '3code': 'threecode', 'copilot-cli': 'copilot' };
const stages = { checking: 'Checking installation', installing: 'Updating', verifying: 'Verifying version', succeeded: 'Verified', failed: 'Update stopped' };

/** Every installed tool keeps its own progress and result when the panel reopens. */
export function ConnectedCliUpdateRows({ tools, busy, progress = {}, checking = false, disabled = false, onUpdate }: {
  tools: CliUpdateRecord[]; busy: string | null; progress?: Record<string, CliUpdateProgress>; checking?: boolean;
  disabled?: boolean; onUpdate?: (runtime: StableCli) => void;
}) {
  const [now, setNow] = useState(0);
  const active = Object.values(progress).some(value => !['succeeded', 'failed'].includes(value.stage));
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  return <div style={{ display: 'grid', gap: 12 }}>
    {tools.map(tool => {
      const state = progress[tool.runtimeId];
      const updating = Boolean(state && !['succeeded', 'failed'].includes(state.stage));
      const supportsUpdate = tool.updateSupported ?? ['codex', 'claude-code', 'grok', 'opencode', 'gemini'].includes(tool.runtimeId);
      const seconds = state ? Math.max(0, Math.floor((now - state.startedAt) / 1000)) : 0;
      return <div key={tool.runtimeId} data-cli-update-row={tool.runtimeId} aria-busy={updating || checking} style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <span aria-hidden="true" style={{ width: 16, height: 16, marginTop: 3, display: 'inline-flex', flexShrink: 0 }}><ProviderMarkGlyph mark={marks[tool.runtimeId] ?? 'terminal'} size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5 }}>{tool.label}</div>
          <div style={{ marginTop: 2, fontSize: 10.5, color: 'var(--t-text-muted)', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
            {tool.installedVersion ?? 'Version unavailable'}{tool.status === 'update-available' && tool.latestVersion ? ` → ${tool.latestVersion}` : ''}
          </div>
          {state || checking ? <div role="status" aria-live="polite" style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.5, color: state?.stage === 'failed' ? 'var(--t-danger)' : 'var(--t-text-secondary)' }}>
            {checking && !updating ? 'Checking version…' : state ? `${stages[state.stage]}${updating ? `… ${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}` : ''}${state.message ? ` · ${state.message}` : ''}` : ''}
          </div> : null}
        </div>
        {onUpdate && supportsUpdate && tool.status === 'update-available' ? <button type="button" aria-label={`Update ${tool.label}`} disabled={disabled || checking}
          onClick={() => onUpdate(tool.runtimeId as StableCli)} style={{ ...actionStyle, cursor: disabled || checking ? 'wait' : 'pointer' }}>
          {updating || busy === tool.runtimeId ? 'Updating…' : 'Update'}
        </button> : onUpdate && (tool.status === 'unknown' || tool.status === 'update-available') ? <button type="button" aria-label={`Update instructions for ${tool.label}`} disabled={disabled}
          title={tool.updateHint ?? 'Use the original updater, then check the version again.'}
          onClick={() => { if (tool.updateUrl) openExternalUrl(tool.updateUrl); else window.dispatchEvent(new CustomEvent('cortex:open-settings-tab', { detail: { tab: 'providers', section: `${tool.label} connection` } })); }} style={actionStyle}>Instructions</button>
          : <span style={{ flexShrink: 0, paddingTop: 5, fontSize: 10.5, color: 'var(--t-text-muted)' }}>{tool.status === 'current' ? 'Current' : 'Check again'}</span>}
      </div>;
    })}
  </div>;
}
const actionStyle = { flexShrink: 0, height: 26, borderRadius: 7, border: 0, paddingTop: 0, paddingBottom: 0, paddingLeft: 8, paddingRight: 8,
  font: 'inherit', fontSize: 11, fontWeight: 300, color: 'var(--t-text)', background: 'var(--t-hover)', cursor: 'pointer' } as const;
