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

function badgeTone(badge: ChatModelBadge): { color: string; background: string; borderColor: string } {
  if (badge === 'FREE') {
    return {
      color: 'var(--t-terminal-ansi-green)',
      background: 'color-mix(in srgb, var(--t-terminal-ansi-green) 12%, transparent)',
      borderColor: 'color-mix(in srgb, var(--t-terminal-ansi-green) 28%, transparent)',
    };
  }
  if (badge === 'PREMIUM') {
    return {
      color: 'var(--t-accent)',
      background: 'var(--t-accent-soft)',
      borderColor: 'var(--t-accent-border)',
    };
  }
  return {
    color: 'var(--t-text-muted)',
    background: 'var(--t-divider-subtle)',
    borderColor: 'var(--t-border)',
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
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
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
              paddingTop: 4,
              paddingRight: 8,
              paddingBottom: 4,
              paddingLeft: 10,
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
            onMouseEnter={(event) => {
              if (selected) return;
              event.currentTarget.style.background = 'var(--t-panel-hover)';
              event.currentTarget.style.borderColor = 'var(--t-border)';
            }}
            onMouseLeave={(event) => {
              if (selected) return;
              event.currentTarget.style.background = 'transparent';
              event.currentTarget.style.borderColor = 'var(--t-border)';
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
                flexShrink: 0,
                minWidth: 54,
                paddingTop: 2,
                paddingRight: 6,
                paddingBottom: 2,
                paddingLeft: 6,
                borderRadius: 999,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: tone.borderColor,
                background: tone.background,
                color: tone.color,
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textAlign: 'center',
                fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
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
