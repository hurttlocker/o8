'use client';

import { useState } from 'react';
import { getRuntimeCapability, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { THINKING_EFFORT_LABELS, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { WorkerStartMode } from '@/lib/operator/worker-start-mode';
import { supportedEffortsForLead } from './state';
import { workerModelForDisplay, type ComposerWorkerDefaults } from './worker-settings';
import { useUltraEffortPreference } from './UltraEffortPreference';

export function WorkerPickerOptions({ runtime, defaults, saving, onEffortChange, effortLocked = false, providerDefault = false }: {
  runtime: OrchestratorRuntime;
  defaults: ComposerWorkerDefaults;
  saving: boolean;
  onEffortChange?: (effort: ThinkingEffort, runtime: OrchestratorRuntime) => void;
  onStartChange: (mode: WorkerStartMode) => void;
  effortLocked?: boolean;
  providerDefault?: boolean;
}) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const ultraEnabled = useUltraEffortPreference();
  const supportsEffort = !providerDefault && getRuntimeCapability(runtime).reasoningEffort && (runtime === 'codex' || runtime === 'claude-code');
  const current = runtime === 'codex' ? defaults.codexWorkerEffort ?? 'adaptive' : defaults.claudeWorkerEffort ?? 'adaptive';
  const choices: readonly ThinkingEffort[] = supportsEffort
    ? ['adaptive', ...supportedEffortsForLead(runtime === 'codex' ? 'codex' : 'claude', workerModelForDisplay(runtime, defaults), false, false, ultraEnabled)] : [];
  return <div style={{ borderTop: '1px solid var(--t-border)', paddingTop: 6, paddingRight: 8, paddingBottom: 4, paddingLeft: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 26, fontSize: 10.5, color: 'var(--t-text-muted)' }}>
      <span>Worker thinking</span>
      {supportsEffort && onEffortChange ? <button type="button" aria-label="Worker thinking" aria-expanded={thinkingExpanded} disabled={saving || effortLocked} onClick={() => setThinkingExpanded(!thinkingExpanded)}
        style={{ borderWidth: 0, borderRadius: 5, background: thinkingExpanded ? 'var(--t-hover)' : 'transparent', color: 'var(--t-text-secondary)', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300, cursor: saving || effortLocked ? 'default' : 'pointer', paddingTop: 3, paddingRight: 4, paddingBottom: 3, paddingLeft: 4 }}>
        {current === 'adaptive' ? 'Provider default' : THINKING_EFFORT_LABELS[current].long} · ⌄
      </button> : <span data-testid="worker-provider-default">Provider default</span>}
    </div>
    {thinkingExpanded && supportsEffort ? <div aria-label="Worker thinking choices" style={{ display: 'flex', flexWrap: 'wrap', gap: 3, paddingTop: 3, paddingBottom: 5 }}>
      {choices.map((effort) => <button key={effort} type="button" aria-pressed={effort === current} disabled={saving || effortLocked} onClick={() => { onEffortChange?.(effort, runtime); setThinkingExpanded(false); }} style={{ borderWidth: 0, borderRadius: 5, paddingTop: 4, paddingRight: 6, paddingBottom: 4, paddingLeft: 6, background: current === effort ? 'var(--t-accent-soft)' : 'var(--t-hover)', color: current === effort ? 'var(--t-accent)' : 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300, cursor: 'pointer' }}>{effort === 'adaptive' ? 'Provider default' : THINKING_EFFORT_LABELS[effort].long}</button>)}
    </div> : null}
  </div>;
}
