'use client';

import { useEffect, useMemo, useState } from 'react';

export interface SymonCapability {
  id: string;
  category: string;
  title: string;
  summary: string;
  examples: string[];
  toolNames: string[];
  availability: 'ready' | 'setup_required' | 'unavailable';
  availabilityDetail?: string;
  approval: 'read_only' | 'may_require_approval';
}

interface SymonCapabilitiesPanelProps {
  machineDisplayName: string;
  onBack: () => void;
  onStarted: () => void;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function capabilitiesFromToolResult(value: unknown): SymonCapability[] {
  const result = recordValue(value);
  const observed = recordValue(result?.observedData);
  const payload = observed ?? result;
  if (Array.isArray(payload?.capabilities)) {
    return payload.capabilities as SymonCapability[];
  }
  const detail = payload?.error ?? result?.error;
  throw new Error(typeof detail === 'string' ? detail : 'Capability list unavailable');
}

function capabilityMeta(capability: SymonCapability): string {
  if (capability.availability === 'setup_required') return 'Setup needed';
  if (capability.availability === 'unavailable') return 'Unavailable in this build';
  return capability.approval === 'read_only' ? 'Read-only' : 'Approval when needed';
}

function CapabilityRow({
  capability,
  busyPrompt,
  onRun,
}: {
  capability: SymonCapability;
  busyPrompt: string;
  onRun: (prompt: string) => void;
}) {
  const ready = capability.availability === 'ready';
  return (
    <section
      aria-label={capability.title}
      style={{
        paddingTop: 10,
        paddingRight: 0,
        paddingBottom: 10,
        paddingLeft: 0,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div
          style={{
            color: ready ? 'var(--t-text)' : 'var(--t-text-muted)',
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
          }}
        >
          {capability.title}
        </div>
        <div
          style={{
            marginLeft: 'auto',
            color: capability.availability === 'setup_required' ? 'var(--t-warning)' : 'var(--t-text-faint)',
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            lineHeight: 1.25,
            whiteSpace: 'nowrap',
          }}
        >
          {capabilityMeta(capability)}
        </div>
      </div>
      <div
        style={{
          marginTop: 4,
          color: 'var(--t-text-muted)',
          fontSize: 11,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          lineHeight: 1.4,
        }}
      >
        {capability.availabilityDetail || capability.summary}
      </div>
      {ready ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 6 }}>
          {capability.examples.map((prompt) => {
            const busy = busyPrompt === prompt;
            return (
              <button
                key={prompt}
                type="button"
                disabled={busy}
                onClick={() => onRun(prompt)}
                onMouseEnter={(event) => { if (!busy) event.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  minHeight: 44,
                  paddingTop: 7,
                  paddingRight: 8,
                  paddingBottom: 7,
                  paddingLeft: 8,
                  borderWidth: 0,
                  borderRadius: 7,
                  background: 'transparent',
                  color: 'var(--t-text)',
                  cursor: busy ? 'wait' : 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font-sans-system)',
                  fontSize: 12,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  lineHeight: 1.35,
                  opacity: busy ? 0.6 : 1,
                  transition: 'background 120ms ease, opacity 120ms ease',
                }}
              >
                <span>{busy ? 'Starting…' : `“${prompt}”`}</span>
                <span
                  aria-hidden
                  style={{
                    marginLeft: 'auto',
                    paddingLeft: 10,
                    color: 'var(--t-text-faint)',
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  Ask
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

export function SymonCapabilitiesPanel({
  machineDisplayName,
  onBack,
  onStarted,
}: SymonCapabilitiesPanelProps) {
  const [capabilities, setCapabilities] = useState<SymonCapability[] | null>(null);
  const [error, setError] = useState('');
  const [busyPrompt, setBusyPrompt] = useState('');

  useEffect(() => {
    let alive = true;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<unknown>('realtime_invoke_tool', {
        name: 'symon_capabilities',
        args: {},
        sessionId: 'desktop',
        utterance: 'Show Symon capabilities',
      }))
      .then((result) => {
        const nextCapabilities = capabilitiesFromToolResult(result);
        if (alive) setCapabilities(nextCapabilities);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : 'Capability list unavailable');
      });
    return () => { alive = false; };
  }, []);

  const grouped = useMemo(() => {
    const groups = new Map<string, SymonCapability[]>();
    for (const capability of capabilities ?? []) {
      const group = groups.get(capability.category) ?? [];
      group.push(capability);
      groups.set(capability.category, group);
    }
    return Array.from(groups.entries());
  }, [capabilities]);

  const runPrompt = (prompt: string) => {
    if (busyPrompt) return;
    setBusyPrompt(prompt);
    setError('');
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('agent_run', { prompt }))
      .then(() => onStarted())
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : 'Symon could not start that prompt');
        setBusyPrompt('');
      });
  };

  return (
    <div style={{ width: '100%', minHeight: 180 }}>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 44 }}>
        <button
          type="button"
          aria-label="Back to Symon controls"
          onClick={onBack}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            marginLeft: -8,
            borderWidth: 0,
            borderRadius: 7,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 18,
            fontWeight: 300,
            transition: 'background 120ms ease',
          }}
        >
          ‹
        </button>
        <div>
          <div style={{ color: 'var(--t-text)', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
            What Symon can do
          </div>
          <div style={{ marginTop: 4, color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
            Live on {machineDisplayName}
          </div>
        </div>
      </div>
      {error ? (
        <div role="status" style={{ color: 'var(--t-danger)', fontSize: 11, fontWeight: 300, lineHeight: 1.4, paddingTop: 8, paddingBottom: 8 }}>
          {error}
        </div>
      ) : null}
      {capabilities === null && !error ? (
        <div style={{ color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300, paddingTop: 16 }}>
          Reading this Mac…
        </div>
      ) : (
        <div style={{ maxHeight: 410, overflowY: 'auto', paddingRight: 4 }}>
          {grouped.map(([category, items]) => (
            <div key={category}>
              <div
                style={{
                  paddingTop: 12,
                  color: 'var(--t-text-faint)',
                  fontSize: 9,
                  fontWeight: 300,
                  letterSpacing: '0.04em',
                  lineHeight: '14px',
                  textTransform: 'uppercase',
                }}
              >
                {category}
              </div>
              {items.map((capability) => (
                <CapabilityRow key={capability.id} capability={capability} busyPrompt={busyPrompt} onRun={runPrompt} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
