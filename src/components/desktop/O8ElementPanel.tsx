'use client';

import { useEffect, useState } from 'react';
import type { PickedElement } from '@/lib/browser/element-picker-bridge';

interface O8ElementPanelProps {
  element: PickedElement;
  onClose: () => void;
  onEditWithAI?: (context: string) => void;
  onOpenSource?: (file: string, line: number) => void;
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

function buildDescriptorParts(element: PickedElement): DescriptorPart[] {
  const parts: DescriptorPart[] = [{ text: `<${element.tagName.toLowerCase()}`, color: '#ffffff' }];

  element.classList.forEach((className) => {
    parts.push({ text: `.${className}`, color: '#60a5fa' });
  });

  if (element.id) {
    parts.push({ text: `#${element.id}`, color: '#4ade80' });
  }

  parts.push({ text: '>', color: '#ffffff' });
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
    return [{ text: '...', color: '#ffffff' }];
  }

  const lastPart = nextParts[nextParts.length - 1];
  nextParts[nextParts.length - 1] = { ...lastPart, text: `${lastPart.text}...` };
  return nextParts;
}

function buildPlainDescriptor(element: PickedElement): string {
  return buildDescriptorParts(element).map((part) => part.text).join('');
}

function buildTextTarget(element: PickedElement): string {
  const classSuffix = element.classList.length > 0 ? `.${element.classList.join('.')}` : '';
  return `<${element.tagName.toLowerCase()}${classSuffix}>`;
}

function buildTextEditContext(element: PickedElement, nextText: string): string {
  return `Change the text of ${buildTextTarget(element)} from ${JSON.stringify(element.textContent)} to ${JSON.stringify(nextText)}`;
}

function buildEditContext(element: PickedElement, draftText: string): string {
  const details = [
    `Edit the selected browser element.`,
    `Element: ${buildPlainDescriptor(element)}`,
    `Selector: ${element.cssSelector}`,
    element.textContent ? `Text: ${JSON.stringify(element.textContent)}` : '',
    draftText.trim() && draftText !== element.textContent ? `Requested text: ${JSON.stringify(draftText)}` : '',
    `Styles: color ${element.computedStyles.color}; background ${element.computedStyles.backgroundColor}; font-size ${element.computedStyles.fontSize}; padding ${element.computedStyles.padding}; margin ${element.computedStyles.margin}; display ${element.computedStyles.display}`,
  ].filter(Boolean);

  return details.join('\n');
}

function resolveSourceLocation(element: PickedElement) {
  const file = element.attributes['data-source-file']
    || element.attributes['data-file']
    || element.attributes['data-path']
    || element.cssSelector
    || element.tagName;
  const lineValue = element.attributes['data-source-line'] || element.attributes['data-line'] || '1';
  const line = Number.parseInt(lineValue, 10);

  return {
    file,
    line: Number.isFinite(line) && line > 0 ? line : 1,
  };
}

function isInteractiveValue(value: string) {
  return value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)';
}

export function O8ElementPanel({ element, onClose, onEditWithAI, onOpenSource }: O8ElementPanelProps) {
  const [draftText, setDraftText] = useState(element.textContent);
  const [isVisible, setIsVisible] = useState(false);
  const descriptorParts = truncateDescriptorParts(buildDescriptorParts(element), 60);
  const descriptorTitle = buildPlainDescriptor(element);

  useEffect(() => {
    setDraftText(element.textContent);
  }, [element]);

  useEffect(() => {
    setIsVisible(false);
    const frame = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [element]);

  const handleTextSubmit = () => {
    if (!onEditWithAI) {
      return;
    }
    onEditWithAI(buildTextEditContext(element, draftText));
  };

  const handleOpenSource = () => {
    if (!onOpenSource) {
      return;
    }
    const source = resolveSourceLocation(element);
    onOpenSource(source.file, source.line);
  };

  return (
    <div
      style={{
        margin: '0 12px 0',
        borderTop: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 14,
        background: 'rgba(20,20,25,0.95)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 22px 40px rgba(0,0,0,0.24)',
        maxHeight: 220,
        overflow: 'auto',
        transform: isVisible ? 'translateY(0)' : 'translateY(14px)',
        opacity: isVisible ? 1 : 0,
        transition: 'transform 220ms ease, opacity 220ms ease',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px 10px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
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
            background: 'rgba(255,255,255,0.08)',
            cursor: 'pointer',
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.72)" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block' }}>
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
                color: 'rgba(255,255,255,0.48)',
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
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.05)',
                color: 'rgba(255,255,255,0.88)',
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
              color: 'rgba(255,255,255,0.48)',
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
                    background: 'rgba(255,255,255,0.04)',
                  }}
                >
                  {showSwatch ? (
                    <div
                      style={{
                        width: 12,
                        height: 12,
                        flexShrink: 0,
                        borderRadius: 999,
                        border: '1px solid rgba(255,255,255,0.18)',
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
                      color: 'rgba(255,255,255,0.88)',
                      fontSize: 12,
                      fontFamily: MONO_FONT,
                    }}
                  >
                    {value}
                  </span>
                  <span
                    style={{
                      color: 'rgba(255,255,255,0.42)',
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

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <button
            type="button"
            onClick={() => onEditWithAI?.(buildEditContext(element, draftText))}
            style={{
              height: 28,
              border: 'none',
              borderRadius: 8,
              background: '#2563eb',
              color: '#ffffff',
              padding: '0 12px',
              fontSize: 12,
              fontWeight: 600,
              cursor: onEditWithAI ? 'pointer' : 'default',
            }}
          >
            Edit with AI
          </button>
          <button
            type="button"
            onClick={handleOpenSource}
            disabled={!onOpenSource}
            style={{
              height: 28,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.78)',
              padding: '0 12px',
              fontSize: 12,
              fontWeight: 600,
              cursor: onOpenSource ? 'pointer' : 'default',
              opacity: onOpenSource ? 1 : 0.4,
            }}
          >
            Open Source
          </button>
        </div>
      </div>
    </div>
  );
}
