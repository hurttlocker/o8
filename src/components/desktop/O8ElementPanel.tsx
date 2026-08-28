'use client';

import { useEffect, useState } from 'react';
import { buildEditContext, buildTextEditContext, type ElementEditContext } from '@/lib/browser/edit-context';
import type { GrabbedElement } from '@/lib/browser/grab';
import type { UiLoopEditOutcome, WarmUiLoopPacket } from './design-mode/ui-loop-edit';

interface O8ElementPanelProps {
  element: GrabbedElement;
  onClose: () => void;
  onEditWithAI?: (
    context: ElementEditContext,
    options: { forceFresh: boolean },
  ) => UiLoopEditOutcome | Promise<UiLoopEditOutcome> | void;
  onFocusPacket?: (packet: WarmUiLoopPacket) => void;
}

type DescriptorPart = {
  color: string;
  text: string;
};

const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const LABEL_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
const STYLE_ITEMS = [
  { key: 'color', label: 'color', swatch: true },
  { key: 'backgroundColor', label: 'background', swatch: true },
  { key: 'fontSize', label: 'font-size', swatch: false },
  { key: 'padding', label: 'padding', swatch: false },
  { key: 'margin', label: 'margin', swatch: false },
  { key: 'display', label: 'display', swatch: false },
] as const;

function buildDescriptorParts(element: GrabbedElement): DescriptorPart[] {
  const parts: DescriptorPart[] = [{ text: `<${element.tagName.toLowerCase()}`, color: 'var(--t-text)' }];

  element.classList.forEach((className) => {
    parts.push({ text: `.${className}`, color: 'var(--t-accent)' });
  });

  if (element.id) {
    parts.push({ text: `#${element.id}`, color: 'var(--t-text-muted)' });
  }

  parts.push({ text: '>', color: 'var(--t-text)' });
  return parts;
}

function truncateDescriptorParts(parts: DescriptorPart[], maxLength: number): DescriptorPart[] {
  const fullText = parts.map((part) => part.text).join('');
  if (fullText.length <= maxLength) {
    return parts;
  }

  const nextParts: DescriptorPart[] = [];
  let remaining = Math.max(maxLength - 3, 0);

  for (let index = 0; index < parts.length && remaining > 0; index += 1) {
    const part = parts[index];
    const text = part.text.slice(0, remaining);
    if (!text) {
      continue;
    }
    nextParts.push({ ...part, text });
    remaining -= text.length;
  }

  if (nextParts.length === 0) {
    return [{ text: '...', color: 'var(--t-text)' }];
  }

  const lastPart = nextParts[nextParts.length - 1];
  nextParts[nextParts.length - 1] = { ...lastPart, text: `${lastPart.text}...` };
  return nextParts;
}

function buildPlainDescriptor(element: GrabbedElement): string {
  return buildDescriptorParts(element).map((part) => part.text).join('');
}

function isInteractiveValue(value: string) {
  return value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
}

export function O8ElementPanel({ element, onClose, onEditWithAI, onFocusPacket }: O8ElementPanelProps) {
  const [draftText, setDraftText] = useState(element.textContent);
  const [isVisible, setIsVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<WarmUiLoopPacket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const descriptorParts = truncateDescriptorParts(buildDescriptorParts(element), 60);
  const descriptorTitle = buildPlainDescriptor(element);

  useEffect(() => {
    setDraftText(element.textContent);
    setReceipt(null);
    setError(null);
  }, [element]);

  useEffect(() => {
    setIsVisible(false);
    const frame = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [element]);

  const submitEdit = async (context: ElementEditContext, forceFresh: boolean) => {
    if (!onEditWithAI || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onEditWithAI(context, { forceFresh });
      if (outcome?.kind === 'steered') setReceipt(outcome.packet);
      if (outcome?.kind === 'error') setError(outcome.message);
    } finally {
      setBusy(false);
    }
  };

  const handleTextSubmit = () => void submitEdit(buildTextEditContext(element, draftText), false);

  return (
    <div
      className="cortex-scroll-fade-y cortex-themed-scroll"
      style={{
        border: '1px solid var(--t-divider)',
        borderRadius: 14,
        background: 'var(--t-panel-translucent)',
        backdropFilter: 'blur(18px) saturate(1.5)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.5)',
        boxShadow: 'var(--t-glass-shadow)',
        maxHeight: '70vh',
        overflow: 'auto',
        transform: isVisible ? 'translateY(0)' : 'translateY(14px)',
        opacity: isVisible ? 1 : 0,
        transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px 10px',
          borderBottom: '1px solid var(--t-divider)',
        }}
      >
        <div
          title={descriptorTitle}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            fontSize: 13,
            fontFamily: MONO_FONT,
          }}
        >
          {descriptorParts.map((part, index) => (
            <span key={`${part.text}-${index}`} style={{ color: part.color }}>
              {part.text}
            </span>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close element panel"
          style={{
            width: 24,
            height: 24,
            border: 'none',
            borderRadius: 8,
            background: 'var(--t-hover)',
            cursor: 'pointer',
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-muted)" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block' }}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div style={{ display: 'grid', gap: 14, padding: 14 }}>
        {element.textContent.trim() ? (
          <div style={{ display: 'grid', gap: 8 }}>
            <span
              style={{
                color: 'var(--t-text-faint)',
                fontSize: 12,
                fontFamily: LABEL_FONT,
              }}
            >
              Text
            </span>
            <input
              type="text"
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleTextSubmit();
                }
              }}
              style={{
                width: '100%',
                height: 36,
                borderRadius: 10,
                border: '1px solid var(--t-divider)',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                padding: '0 12px',
                outline: 'none',
                fontSize: 13,
                fontFamily: LABEL_FONT,
              }}
            />
          </div>
        ) : null}

        <div style={{ display: 'grid', gap: 8 }}>
          <span
            style={{
              color: 'var(--t-text-faint)',
              fontSize: 12,
              fontFamily: LABEL_FONT,
            }}
          >
            Styles
          </span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
            {STYLE_ITEMS.map((item) => {
              const value = element.computedStyles[item.key] || 'n/a';
              const showSwatch = 'swatch' in item && item.swatch;

              return (
                <div
                  key={item.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minWidth: 0,
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: 'var(--t-hover)',
                  }}
                >
                  {showSwatch ? (
                    <div
                      style={{
                        width: 12,
                        height: 12,
                        flexShrink: 0,
                        borderRadius: 999,
                        border: '1px solid var(--t-divider)',
                        background: isInteractiveValue(value) ? value : 'transparent',
                      }}
                    />
                  ) : null}
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--t-text)',
                      fontSize: 12,
                      fontFamily: MONO_FONT,
                    }}
                  >
                    {value}
                  </span>
                  <span
                    style={{
                      color: 'var(--t-text-faint)',
                      fontSize: 11,
                      fontFamily: LABEL_FONT,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {receipt ? (
          <div
            role="status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              minHeight: 44,
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 12,
              border: '1px solid var(--t-success-border)',
              borderRadius: 10,
              background: 'var(--t-success-soft)',
              color: 'var(--t-text)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '-0.1px',
            }}
          >
            <span>Steered the running packet ·</span>
            <button
              type="button"
              onClick={() => onFocusPacket?.(receipt)}
              style={{
                minHeight: 44,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-accent)',
                paddingTop: 0,
                paddingRight: 2,
                paddingBottom: 0,
                paddingLeft: 2,
                fontFamily: 'var(--font-sans-system)',
                fontSize: 11,
                fontWeight: 300,
                textDecoration: 'underline',
                textUnderlineOffset: 2,
                cursor: onFocusPacket ? 'pointer' : 'default',
              }}
            >
              {receipt.label}
            </button>
          </div>
        ) : error ? (
          <div
            role="alert"
            style={{
              paddingTop: 10,
              paddingRight: 12,
              paddingBottom: 10,
              paddingLeft: 12,
              border: '1px solid var(--t-danger-border)',
              borderRadius: 10,
              background: 'var(--t-danger-soft)',
              color: 'var(--t-text)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 11,
              fontWeight: 300,
              lineHeight: 1.35,
            }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            disabled={!onEditWithAI || busy}
            title="Steer the warm Design Mode packet. Hold ⌥ while clicking to start a new orchestrator turn."
            onClick={(event) => void submitEdit(buildEditContext(element, draftText), event.altKey)}
            style={{
              minHeight: 44,
              border: 'none',
              borderRadius: 8,
              background: 'var(--t-accent)',
              color: '#ffffff',
              paddingTop: 0,
              paddingRight: 12,
              paddingBottom: 0,
              paddingLeft: 12,
              fontSize: 12,
              fontWeight: 300,
              cursor: onEditWithAI && !busy ? 'pointer' : 'default',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? 'Steering packet…' : 'Edit with AI'}
          </button>
        </div>
      </div>
    </div>
  );
}
