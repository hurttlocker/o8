'use client';

import {
  CHAT_MODEL_OPTIONS,
  persistChatModelChoice,
  type ChatModelBadge,
  type ChatModelId,
} from './chat-models';

interface ChatModelPickerProps {
  workspaceKey: string;
  selectedModelId: ChatModelId;
  onSelectModel: (modelId: ChatModelId) => void;
}

function badgeTone(badge: ChatModelBadge): { background: string; borderColor: string; color: string } {
  if (badge === 'FREE') {
    return {
      background: 'color-mix(in srgb, var(--t-terminal-ansi-green) 12%, transparent)',
      borderColor: 'color-mix(in srgb, var(--t-terminal-ansi-green) 28%, transparent)',
      color: 'var(--t-terminal-ansi-green)',
    };
  }
  if (badge === 'PREMIUM') {
    return {
      background: 'var(--t-accent-soft)',
      borderColor: 'var(--t-accent-border)',
      color: 'var(--t-accent)',
    };
  }
  return {
    background: 'var(--t-bg-card)',
    borderColor: 'var(--t-border)',
    color: 'var(--t-text-muted)',
  };
}

export function ChatModelPicker({ workspaceKey, selectedModelId, onSelectModel }: ChatModelPickerProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        paddingTop: 4,
        paddingRight: 4,
        paddingBottom: 4,
        paddingLeft: 4,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border)',
        background: 'var(--t-panel)',
        backdropFilter: 'blur(18px) saturate(1.3)',
        boxShadow: 'var(--t-panel-shadow)',
      }}
    >
      {CHAT_MODEL_OPTIONS.map((option) => {
        const selected = option.id === selectedModelId;
        const tone = badgeTone(option.badge);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              persistChatModelChoice(workspaceKey, option.id);
              onSelectModel(option.id);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              width: '100%',
              height: 38,
              paddingTop: 0,
              paddingRight: 8,
              paddingBottom: 0,
              paddingLeft: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: selected ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-border)',
              background: selected ? 'color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 10%, transparent)' : 'transparent',
              color: 'var(--t-text)',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              transition: 'border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), background 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <span
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0,
                  color: 'var(--t-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {option.label}
              </span>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 500,
                  letterSpacing: 0,
                  color: 'var(--t-text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {option.subtitle}
              </span>
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: 18,
                minWidth: 48,
                paddingTop: 0,
                paddingRight: 6,
                paddingBottom: 0,
                paddingLeft: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: tone.borderColor,
                background: tone.background,
                color: tone.color,
                fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.04em',
                flexShrink: 0,
              }}
            >
              {option.badge}
            </span>
          </button>
        );
      })}
    </div>
  );
}
