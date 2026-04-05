'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  THEME_ACCENT_SOFT,
  THEME_BG_CARD,
  THEME_PANEL_GLASS,
} from '@/components/desktop/workspace-terminal/constants';
import type { WorkspaceCliModelOption } from '@/components/desktop/workspace-terminal/types';

interface WorkspaceCliModelPickerProps {
  selected: WorkspaceCliModelOption;
  models: WorkspaceCliModelOption[];
  disabled: boolean;
  onSelect: (modelId: string) => void;
}

export function WorkspaceCliModelPicker({
  selected,
  models,
  disabled,
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
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 999,
          background: THEME_BG_CARD,
          border: '1px solid var(--t-panel-border)',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--t-text-secondary)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: selected.color }} />
        {selected.label}
        <ChevronDown
          size={11}
          style={{
            color: 'var(--t-text-muted)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 150ms ease',
          }}
        />
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
            background: THEME_PANEL_GLASS,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: 'var(--t-panel-shadow)',
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
                background: model.id === selected.id ? THEME_ACCENT_SOFT : 'transparent',
                color: 'var(--t-text)',
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = THEME_ACCENT_SOFT;
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = model.id === selected.id ? THEME_ACCENT_SOFT : 'transparent';
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: model.color, flexShrink: 0 }} />
              <span style={{ fontWeight: 500 }}>{model.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
