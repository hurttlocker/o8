'use client';

/**
 * OrchestratorEmptyState — the curated landing view for the Orchestrator
 * tab when it has no messages yet.
 *
 * Single centered column: greeting + assistant-style quick-action grid.
 */

import { memo } from 'react';
import { PROMPT_ICONS } from '@/components/desktop/llm-chat/shared';

type PromptIconKey = keyof typeof PROMPT_ICONS;

interface QuickAction {
  id: string;
  iconKey: PromptIconKey;
  label: string;
  detail: string;
  prompt: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'review-pending',
    iconKey: 'diff',
    label: 'Review pending agent changes',
    detail: 'Check diffs waiting for approval',
    prompt: 'Walk me through every pending diff waiting for approval. For each one: what repo, what the agent changed, and whether it looks safe to merge.',
  },
  {
    id: 'ship-status',
    iconKey: 'search',
    label: 'What did agents ship today?',
    detail: 'Summarize merged work and activity',
    prompt: 'Summarize everything that merged into main today across all agents. Group by repo, highlight anything risky, and tell me the overall momentum.',
  },
  {
    id: 'token-spend',
    iconKey: 'tree',
    label: "Audit today's token spend",
    detail: 'Cost breakdown by agent and model',
    prompt: 'Audit today\'s token spend across every agent and model. Break down what spent the most, what looks unusual, and what I should change if anything is wasteful.',
  },
  {
    id: 'dispatch',
    iconKey: 'rocket',
    label: 'Dispatch a task',
    detail: 'Scope and route work to an agent',
    prompt: 'Help me scope a task to dispatch. Ask me what repo and what needs to happen, then draft a tight, one-paragraph task packet I can send.',
  },
  {
    id: 'recent-changes',
    iconKey: 'file',
    label: 'Review the most recent changes',
    detail: 'Analyze recent commits for issues',
    prompt: 'Review the most recent changes across the active repos. Summarize the commits, call out possible issues, and tell me what should be checked before merging more work.',
  },
  {
    id: 'attention',
    iconKey: 'search',
    label: 'What needs my attention?',
    detail: 'Surface blockers, failures, and stale work',
    prompt: 'Surface what needs my attention right now across agents, repos, CI, issues, and stale work. Prioritize blockers first and keep the summary tight.',
  },
];

interface OrchestratorEmptyStateProps {
  greeting: string;
  runtimeLabel: string;
  onActionClick: (prompt: string) => void;
}

function PromptIcon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <path d={d} />
    </svg>
  );
}

function OrchestratorEmptyStateBase({
  greeting,
  runtimeLabel,
  onActionClick,
}: OrchestratorEmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 32,
          width: '100%',
          maxWidth: 520,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <div
            style={{
              fontSize: 28,
              fontWeight: 300,
              color: 'var(--t-text-secondary)',
              letterSpacing: '-0.03em',
              lineHeight: 1.2,
              fontFamily: 'var(--font-sans-system)',
              textAlign: 'center',
            }}
          >
            {greeting}
          </div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--t-text-muted)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              marginTop: 2,
            }}
          >
            {runtimeLabel}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 0,
            width: '100%',
            borderWidth: 0.5,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            borderRadius: 14,
            overflow: 'hidden',
            background: 'transparent',
          }}
        >
          {QUICK_ACTIONS.map((action, index) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onActionClick(action.prompt)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                paddingTop: 16,
                paddingRight: 16,
                paddingBottom: 16,
                paddingLeft: 16,
                borderWidth: 0,
                borderRightWidth: index % 2 === 0 ? 0.5 : 0,
                borderBottomWidth: index < QUICK_ACTIONS.length - 2 ? 0.5 : 0,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider-subtle)',
                background: 'transparent',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                fontFamily: 'var(--font-sans-system)',
                minHeight: 78,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(37, 99, 235, 0.04)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <span
                style={{
                  color: 'var(--t-text-faint)',
                  flexShrink: 0,
                  lineHeight: 1,
                  marginTop: 1,
                }}
              >
                <PromptIcon d={PROMPT_ICONS[action.iconKey]} />
              </span>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--t-text-secondary)',
                    letterSpacing: '-0.01em',
                    lineHeight: 1.3,
                  }}
                >
                  {action.label}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 400,
                    color: 'var(--t-text-muted)',
                    letterSpacing: '-0.005em',
                    lineHeight: 1.4,
                  }}
                >
                  {action.detail}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export const OrchestratorEmptyState = memo(OrchestratorEmptyStateBase);

export function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  return 'Good evening.';
}
