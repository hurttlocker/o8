'use client';

import { useEffect, useRef, useState } from 'react';

export const UI_FONT = 'var(--font-sans-system)';
export const MONO_FONT = 'var(--font-mono, "SF Mono", Menlo, monospace)';

export const inputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 36,
  paddingTop: 8,
  paddingRight: 11,
  paddingBottom: 8,
  paddingLeft: 11,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider)',
  borderRadius: 9,
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontSize: 12.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  fontFamily: UI_FONT,
  lineHeight: 1.4,
  outline: 'none',
  boxSizing: 'border-box',
};

export const buttonStyle: React.CSSProperties = {
  height: 30,
  paddingTop: 0,
  paddingRight: 12,
  paddingBottom: 0,
  paddingLeft: 12,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider)',
  borderRadius: 8,
  background: 'transparent',
  color: 'var(--t-text-muted)',
  fontSize: 12,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  fontFamily: UI_FONT,
  cursor: 'pointer',
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{
        fontSize: 10,
        fontWeight: 300,
        letterSpacing: '0.04em',
        lineHeight: '14px',
        textTransform: 'uppercase',
        color: 'var(--t-text-faint)',
      }}>
        {label}
      </span>
      {children}
    </div>
  );
}

export interface PickerOption {
  value: string;
  label: string;
  detail?: string;
}

export function InlinePicker({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{
          ...inputStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected?.label ?? value}
        </span>
        <ChevronGlyph open={open} />
      </button>
      {open ? (
        <div style={{
          position: 'absolute',
          top: 42,
          right: 0,
          left: 0,
          zIndex: 4,
          maxHeight: 220,
          overflowY: 'auto',
          paddingTop: 4,
          paddingRight: 4,
          paddingBottom: 4,
          paddingLeft: 4,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          borderRadius: 10,
          background: 'var(--t-panel)',
          boxShadow: 'var(--t-shadow-card)',
        }}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingTop: 7,
                  paddingRight: 8,
                  paddingBottom: 7,
                  paddingLeft: 8,
                  borderWidth: 0,
                  borderRadius: 7,
                  background: active ? 'var(--t-input-bg)' : 'transparent',
                  color: 'var(--t-text)',
                  textAlign: 'left',
                  fontFamily: UI_FONT,
                  cursor: 'pointer',
                }}
              >
                <span style={{ width: 12, flexShrink: 0 }}>{active ? <CheckGlyph /> : null}</span>
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25 }}>
                    {option.label}
                  </span>
                  {option.detail ? (
                    <span style={{
                      fontSize: 9.5,
                      fontWeight: 260,
                      letterSpacing: '-0.4px',
                      lineHeight: 1.25,
                      color: 'var(--t-text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {option.detail}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        color: 'var(--t-text-faint)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
