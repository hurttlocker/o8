import type { CSSProperties } from 'react';

interface DockConfirmationCardProps {
  confirm: { confirmationId: string; taskId: string; summary: string };
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
          Symon wants to
        </span>
        <span
          aria-label="Spoken review for confirmation"
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
          {confirm.summary}
        </span>
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
          Allow
        </button>
      </div>
    </div>
  );
}
