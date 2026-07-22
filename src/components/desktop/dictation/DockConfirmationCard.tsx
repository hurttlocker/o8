import type { CSSProperties } from 'react';

import type { AgentConfirmation } from './useAgentConfirmations';

interface DockConfirmationCardProps {
  confirm: AgentConfirmation;
  onDecision?: (confirmationId: string, taskId: string, allow: boolean) => void;
}

const actionButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 28,
  borderRadius: 14,
  fontSize: 12,
  letterSpacing: '-0.1px',
  textAlign: 'center',
  cursor: 'pointer',
};

/** Fixed-footprint confirmation body with a scrollable review and pinned actions. */
export function DockConfirmationCard({ confirm, onDecision }: DockConfirmationCardProps) {
  const isPlan = confirm.kind === 'plan' && !!confirm.plan?.steps.length;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
        height: '100%',
        minHeight: 0,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 18,
        paddingRight: 18,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          flex: 1,
          flexDirection: 'column',
          gap: 3,
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <span
          style={{
            flexShrink: 0,
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            color: '#ffffffb3',
            textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
          }}
        >
          {isPlan ? 'Symon’s plan' : 'Symon wants to'}
        </span>
        <div
          aria-label={isPlan ? 'Plan review for confirmation' : 'Spoken review for confirmation'}
          tabIndex={0}
          style={{
            display: 'block',
            flex: 1,
            minHeight: 0,
            paddingRight: 4,
            fontSize: 12,
            fontWeight: 320,
            lineHeight: '17px',
            letterSpacing: '-0.1px',
            color: '#fff',
            textShadow: '0 1px 6px rgba(0, 0, 0, 0.35)',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
          title={confirm.summary}
        >
          {isPlan ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
              }}
            >
              {confirm.plan?.steps.map((step, offset) => (
                <div
                  key={`${step.index}-${offset}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '16px minmax(0, 1fr)',
                    gap: 4,
                    alignItems: 'start',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      color: '#ffffff99',
                      fontVariantNumeric: 'tabular-nums',
                      textAlign: 'right',
                    }}
                  >
                    {step.index}.
                  </span>
                  <span>{step.summary}</span>
                </div>
              ))}
            </div>
          ) : confirm.summary}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexShrink: 0,
          gap: 8,
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          onClick={() => onDecision?.(confirm.confirmationId, confirm.taskId, false)}
          style={{
            ...actionButtonStyle,
            paddingLeft: 14,
            paddingRight: 14,
            border: '1px solid #ffffff52',
            background: '#ffffff1f',
            color: '#ffffffeb',
            fontWeight: 400,
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onDecision?.(confirm.confirmationId, confirm.taskId, true)}
          style={{
            ...actionButtonStyle,
            paddingLeft: 18,
            paddingRight: 18,
            border: '1px solid #ffffff80',
            background: '#ffffffeb',
            color: '#1a1730',
            fontWeight: 500,
          }}
        >
          {isPlan ? 'Run plan' : 'Allow'}
        </button>
      </div>
    </div>
  );
}
