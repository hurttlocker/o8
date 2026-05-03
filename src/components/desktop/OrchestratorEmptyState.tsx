'use client';

/**
 * OrchestratorEmptyState — the curated landing view for the Orchestrator
 * tab when it has no messages yet.
 *
 * Single centered column: greeting + 4 quick-action cards. Recent Work
 * was removed in v1 because the Mission rail + Pulse tab + orange
 * latest-dispatch tab marker already cover the surface area.
 */

import { memo } from 'react';

interface QuickAction {
  id: string;
  label: string;
  detail: string;
  prompt: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'whats-active',
    label: "What's active right now?",
    detail: 'Live fleet status, running sessions, blockers',
    prompt: 'Give me a snapshot of every active agent session right now — what runtime, what task, what status, and what needs my attention.',
  },
  {
    id: 'review-pending',
    label: 'Review pending changes',
    detail: 'Diffs waiting for approval across lanes',
    prompt: 'Walk me through every pending diff waiting for approval. For each one: what repo, what the agent changed, and whether it looks safe to merge.',
  },
  {
    id: 'ship-status',
    label: 'What shipped today?',
    detail: 'Merged work and momentum across agents',
    prompt: 'Summarize everything that merged into main today across all agents. Group by repo, highlight anything risky, and tell me the overall momentum.',
  },
  {
    id: 'dispatch',
    label: 'Dispatch a task',
    detail: 'Scope and route work to an agent',
    prompt: 'Help me scope a task to dispatch. Ask me what repo and what needs to happen, then draft a tight, one-paragraph task packet I can send.',
  },
];

interface OrchestratorEmptyStateProps {
  greeting: string;
  runtimeLabel: string;
  onActionClick: (prompt: string) => void;
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
          gap: 28,
          width: '100%',
          maxWidth: 480,
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
              fontSize: 34,
              fontWeight: 300,
              color: 'var(--t-text-secondary)',
              letterSpacing: '-0.03em',
              lineHeight: 1.15,
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              textAlign: 'center',
            }}
          >
            Let&rsquo;s get building.
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--t-text)',
              letterSpacing: '-0.01em',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
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
              marginTop: 4,
            }}
          >
            {runtimeLabel}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))',
            gap: 10,
            width: '100%',
          }}
        >
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onActionClick(action.prompt)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 4,
                paddingTop: 12,
                paddingRight: 14,
                paddingBottom: 12,
                paddingLeft: 14,
                borderRadius: 12,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider-subtle)',
                background: 'var(--t-bg-card)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 120ms cubic-bezier(0.22, 1, 0.36, 1), background 120ms cubic-bezier(0.22, 1, 0.36, 1), transform 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                minHeight: 60,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--t-accent-border)';
                e.currentTarget.style.background = 'var(--t-bg-card-hover, var(--t-bg-card))';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
                e.currentTarget.style.background = 'var(--t-bg-card)';
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.005em',
                }}
              >
                {action.label}
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--t-text-muted)',
                  lineHeight: 1.4,
                }}
              >
                {action.detail}
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
