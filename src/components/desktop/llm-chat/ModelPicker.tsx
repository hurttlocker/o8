import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';

import { MODELS, THEME_ACCENT, THEME_ACCENT_SOFT, THEME_PANEL_GLASS, type ModelOption } from './shared';

export function ModelPicker({
  disabled,
  onSelect,
  selected,
}: {
  disabled: boolean;
  onSelect: (model: ModelOption) => void;
  selected: ModelOption;
}) {
  const [open, setOpen] = useState(false);
  const [dropPos, setDropPos] = useState({ bottom: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      if (dropRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setDropPos({
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { if (!disabled) setOpen((value) => !value); }}
        disabled={disabled}
        style={{ display: 'flex', alignItems: 'center', gap: 5, paddingTop: 5, paddingRight: 6, paddingBottom: 5, paddingLeft: 8, border: 'none', borderRadius: 8, background: open ? THEME_ACCENT_SOFT : 'transparent', color: open ? 'var(--t-text)' : 'var(--t-text-secondary)', fontSize: 13, fontWeight: 400, fontFamily: '-apple-system, system-ui, sans-serif', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, transition: 'color 150ms, background 150ms' }}
        onMouseEnter={(event) => {
          if (disabled || open) return;
          event.currentTarget.style.color = 'var(--t-text)';
          event.currentTarget.style.background = THEME_ACCENT_SOFT;
        }}
        onMouseLeave={(event) => {
          if (open) return;
          event.currentTarget.style.color = 'var(--t-text-secondary)';
          event.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: selected.color, flexShrink: 0 }} />
        {selected.label}
        <ChevronDown size={12} style={{ color: 'var(--t-text-muted)', marginLeft: 2, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
      </button>

      {open ? createPortal(
        <div ref={dropRef} style={{ position: 'fixed', bottom: dropPos.bottom, right: dropPos.right, zIndex: 9999, minWidth: 260, background: THEME_PANEL_GLASS, border: '1px solid var(--t-panel-border)', borderRadius: 12, overflow: 'hidden', boxShadow: 'var(--t-panel-shadow)', animation: 'llmFadeIn 100ms ease-out' }}>
          {MODELS.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => { onSelect(model); setOpen(false); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, border: 'none', background: model.id === selected.id ? THEME_ACCENT_SOFT : 'transparent', color: 'var(--t-text)', fontSize: 13, fontFamily: '-apple-system, system-ui, sans-serif', cursor: 'pointer', textAlign: 'left', transition: 'background 100ms' }}
              onMouseEnter={(event) => { event.currentTarget.style.background = THEME_ACCENT_SOFT; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = model.id === selected.id ? THEME_ACCENT_SOFT : 'transparent'; }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: model.color, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{model.label}</div>
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{model.description}</div>
              </div>
              {model.id === selected.id ? <Check size={14} style={{ color: THEME_ACCENT }} /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
