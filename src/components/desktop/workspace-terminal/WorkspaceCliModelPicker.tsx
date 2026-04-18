'use client';

import { memo, useEffect, useRef, useState } from 'react';
import type { WorkspaceCliModelOption } from '@/components/desktop/workspace-terminal/types';

interface WorkspaceCliModelPickerProps {
  selected: WorkspaceCliModelOption;
  models: WorkspaceCliModelOption[];
  disabled: boolean;
  agentRunning?: boolean;
  runtimeLabel?: string;
  onSelect: (modelId: string) => void;
}

/**
 * Model/status pill for the agent-session composer. Mirrors the orchestrator's
 * ThinkingChip aesthetic — transparent background, hairline border, monospace
 * label, 6px status dot indicating session liveness (green = running, muted =
 * idle). Clicking opens a native-style dropdown to swap models. This replaces
 * the previous green-dot `GPT-5.4 ▾` chunky bubble so Codex + Claude Code
 * composers read like Rams-clean pills instead of Material chips.
 */
function WorkspaceCliModelPickerBase({
  selected,
  models,
  disabled,
  agentRunning = false,
  runtimeLabel,
  onSelect,
}: WorkspaceCliModelPickerProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dropPos, setDropPos] = useState({ bottom: 0, right: 0 });

  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: MouseEvent) => {
      if (btnRef.current?.contains(event.target as Node)) return;
      if (dropRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setDropPos({
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  const dotColor = agentRunning ? '#22c55e' : 'var(--t-text-faint)';

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => {
          if (!disabled) {
            setOpen(!open);
          }
        }}
        disabled={disabled}
        title={agentRunning ? `${runtimeLabel ?? 'Session'} running · ${selected.label}` : `${runtimeLabel ?? 'Session'} idle · ${selected.label}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 26,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-border)',
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          minWidth: 0,
          fontSize: 11.5,
          fontWeight: 400,
          letterSpacing: '0.01em',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
          fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            flexShrink: 0,
            background: dotColor,
          }}
        />
        {runtimeLabel ? <span style={{ color: 'var(--t-text-muted)' }}>{runtimeLabel.toLowerCase()}</span> : null}
        <span style={{ color: 'var(--t-text)' }}>{selected.label}</span>
      </button>

      {open ? (
        <div
          ref={dropRef}
          style={{
            position: 'fixed',
            bottom: dropPos.bottom,
            right: dropPos.right,
            zIndex: 9999,
            minWidth: 220,
            background: 'var(--t-panel-translucent)',
            border: '1px solid var(--t-panel-border)',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => {
                onSelect(model.id);
                setOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 12,
                paddingRight: 12,
                border: 'none',
                background: model.id === selected.id ? 'var(--t-accent-soft)' : 'transparent',
                color: 'var(--t-text)',
                fontSize: 12,
                fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = 'var(--t-accent-soft)';
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = model.id === selected.id ? 'var(--t-accent-soft)' : 'transparent';
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: model.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 500 }}>{model.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export const WorkspaceCliModelPicker = memo(WorkspaceCliModelPickerBase);
