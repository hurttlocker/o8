'use client';

/**
 * OrchestratorEmptyState — the curated landing view for the Orchestrator
 * tab when it has no messages yet.
 *
 * Jobs philosophy applied:
 *   - Big, quiet, confident greeting. No wall of text.
 *   - 4 quick actions, not 6. Focus means saying no.
 *   - Each action is a COMMAND, not a question. The orchestrator is a
 *     control plane — users give it orders, not conversations.
 *   - Clicking an action fills the composer AND sends, so the first
 *     moment of using the Orchestrator is "I clicked a thing and
 *     something happened" not "I have to type."
 */

import { memo } from 'react';

interface QuickAction {
  id: string;
  label: string;
  detail: string;
  prompt: string;
  tone: 'primary' | 'muted';
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'whats-active',
    label: "What's active right now?",
    detail: 'Live fleet status, running sessions, blockers',
    prompt: 'Give me a snapshot of every active agent session right now — what runtime, what task, what status, and what needs my attention.',
    tone: 'primary',
  },
  {
    id: 'review-pending',
    label: 'Review pending changes',
    detail: 'Diffs waiting for approval across lanes',
    prompt: 'Walk me through every pending diff waiting for approval. For each one: what repo, what the agent changed, and whether it looks safe to merge.',
    tone: 'primary',
  },
  {
    id: 'ship-status',
    label: 'What shipped today?',
    detail: 'Merged work and momentum across agents',
    prompt: 'Summarize everything that merged into main today across all agents. Group by repo, highlight anything risky, and tell me the overall momentum.',
    tone: 'muted',
  },
  {
    id: 'dispatch',
    label: 'Dispatch a task to Codex',
    detail: 'Scope and route work to the workhorse',
    prompt: 'Help me scope a task to dispatch to Codex. Ask me what repo and what needs to happen, then draft a tight, one-paragraph task packet I can send.',
    tone: 'muted',
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
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        minHeight: 0,
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        gap: 32,
      }}
    >
      {/* Greeting */}
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
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          {greeting}
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
          Command your fleet.
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

      {/* Quick actions — 2×2 grid, primary actions on top row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))',
          gap: 10,
          width: '100%',
          maxWidth: 560,
        }}
      >
        {QUICK_ACTIONS.map((action) => {
          const isPrimary = action.tone === 'primary';
          return (
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
                borderColor: isPrimary ? 'var(--t-accent-border)' : 'var(--t-divider-subtle)',
                background: isPrimary ? 'var(--t-accent-soft)' : 'var(--t-bg-card)',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'border-color 120ms ease, background 120ms ease, transform 120ms ease',
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                minHeight: 60,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--t-accent-border)';
                e.currentTarget.style.background = isPrimary
                  ? 'var(--t-accent-soft-strong)'
                  : 'var(--t-panel-hover)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = isPrimary
                  ? 'var(--t-accent-border)'
                  : 'var(--t-divider-subtle)';
                e.currentTarget.style.background = isPrimary
                  ? 'var(--t-accent-soft)'
                  : 'var(--t-bg-card)';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.01em',
                  lineHeight: 1.3,
                }}
              >
                {action.label}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 500,
                  color: 'var(--t-text-muted)',
                  lineHeight: 1.4,
                }}
              >
                {action.detail}
              </div>
            </button>
          );
        })}
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
