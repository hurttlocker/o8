'use client';

import React, { useState } from 'react';
import type { ChatEmptyStateProps } from './types';

export function ChatEmptyState({
  scopeLabel,
  title,
  body,
  primaryActionLabel,
  onPrimaryAction,
  prompts,
  onPromptSelect,
}: ChatEmptyStateProps) {
  const [primaryHover, setPrimaryHover] = useState(false);
  const [hoveredPrompt, setHoveredPrompt] = useState<string | null>(null);

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 16,
      paddingRight: 18,
      paddingBottom: 18,
      paddingLeft: 18,
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        borderRadius: 14,
        border: '1px solid var(--t-divider-subtle)',
        background: 'linear-gradient(180deg, var(--t-panel-translucent) 0%, var(--t-bg-card, rgba(148, 163, 184, 0.08)) 100%)',
        boxShadow: 'var(--t-panel-shadow)',
        paddingTop: 18,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {scopeLabel ? (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              alignSelf: 'flex-start',
              minHeight: 20,
              paddingTop: 0,
              paddingRight: 8,
              paddingBottom: 0,
              paddingLeft: 8,
              borderRadius: 10,
              background: 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))',
              border: '1px solid var(--t-accent-border, rgba(37, 99, 235, 0.22))',
              color: 'var(--t-accent, #2563eb)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              {scopeLabel}
            </span>
          ) : null}
          <div style={{
            fontSize: 18,
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: '-0.02em',
            color: 'var(--t-text)',
          }}>
            {title}
          </div>
          <div style={{
            fontSize: 13,
            lineHeight: 1.5,
            letterSpacing: '-0.01em',
            color: 'var(--t-text-muted)',
          }}>
            {body}
          </div>
        </div>

        <div
          aria-hidden="true"
          style={{
            borderRadius: 14,
            border: '1px solid var(--t-divider-subtle)',
            background: 'var(--t-panel, rgba(255, 255, 255, 0.72))',
            paddingTop: 12,
            paddingRight: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 48,
              height: 10,
              borderRadius: 999,
              background: 'var(--t-divider-subtle)',
            }} />
            <div style={{
              width: 20,
              height: 10,
              borderRadius: 999,
              background: 'var(--t-divider-subtle)',
              opacity: 0.7,
            }} />
            <div style={{ flex: 1 }} />
            <div style={{
              width: 54,
              height: 10,
              borderRadius: 999,
              background: 'var(--t-divider-subtle)',
              opacity: 0.6,
            }} />
          </div>
          <div style={{
            width: '88%',
            height: 12,
            borderRadius: 999,
            background: 'linear-gradient(90deg, var(--t-divider-subtle) 0%, var(--t-divider) 100%)',
            opacity: 0.8,
          }} />
          <div style={{
            width: '72%',
            height: 12,
            borderRadius: 999,
            background: 'linear-gradient(90deg, var(--t-divider-subtle) 0%, var(--t-divider) 100%)',
            opacity: 0.72,
          }} />
          <div style={{
            width: '60%',
            height: 12,
            borderRadius: 999,
            background: 'linear-gradient(90deg, var(--t-divider-subtle) 0%, var(--t-divider) 100%)',
            opacity: 0.64,
          }} />
        </div>

        {primaryActionLabel && onPrimaryAction ? (
          <button
            type="button"
            onClick={onPrimaryAction}
            onMouseEnter={() => setPrimaryHover(true)}
            onMouseLeave={() => setPrimaryHover(false)}
            style={{
              minHeight: 44,
              paddingTop: 10,
              paddingRight: 14,
              paddingBottom: 10,
              paddingLeft: 14,
              borderRadius: 12,
              border: '1px solid var(--t-accent-border, rgba(37, 99, 235, 0.22))',
              background: primaryHover
                ? 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))'
                : 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))',
              color: 'var(--t-accent, #2563eb)',
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              cursor: 'pointer',
              fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
              transition: 'transform 160ms ease, background-color 160ms ease, border-color 160ms ease',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {primaryActionLabel}
              <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1, opacity: 0.8 }}>&gt;</span>
            </span>
          </button>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--t-text-faint)',
          }}>
            Starter prompts
          </div>
          {prompts.map((prompt) => {
            const isHovered = hoveredPrompt === prompt.label;
            return (
              <button
                key={prompt.label}
                type="button"
                onClick={() => onPromptSelect(prompt)}
                onMouseEnter={() => setHoveredPrompt(prompt.label)}
                onMouseLeave={() => setHoveredPrompt(null)}
                style={{
                  minHeight: 44,
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  borderRadius: 12,
                  border: `1px solid ${isHovered ? 'var(--t-accent-border, rgba(37, 99, 235, 0.22))' : 'var(--t-divider-subtle)'}`,
                  background: isHovered ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))' : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  textAlign: 'left',
                  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
                  transition: 'transform 160ms ease, background-color 160ms ease, border-color 160ms ease',
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{
                    fontSize: 13,
                    fontWeight: 650,
                    letterSpacing: '-0.01em',
                    color: 'var(--t-text)',
                  }}>
                    {prompt.label}
                  </span>
                  <span style={{
                    fontSize: 11,
                    lineHeight: 1.4,
                    letterSpacing: '-0.01em',
                    color: 'var(--t-text-muted)',
                  }}>
                    {prompt.detail}
                  </span>
                </span>
                <span aria-hidden="true" style={{
                  flexShrink: 0,
                  fontSize: 16,
                  lineHeight: 1,
                  color: 'var(--t-text-faint)',
                }}>
                  &gt;
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
