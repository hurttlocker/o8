import type { MouseEventHandler } from 'react';
import { GripIcon, MinimizeIcon, XIcon } from './ThoughtsIcons';

export function ThoughtsHeader({
  docked,
  minimized,
  title,
  approvalsCount,
  waitingForReply,
  showReset,
  onReset,
  onToggleMinimized,
  onClose,
  onMouseDown,
}: {
  docked: boolean;
  minimized: boolean;
  title: string;
  approvalsCount: number;
  waitingForReply: boolean;
  showReset: boolean;
  onReset: () => void;
  onToggleMinimized: () => void;
  onClose: () => void;
  onMouseDown?: MouseEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: minimized ? '8px 12px' : '10px 14px',
        cursor: docked ? 'default' : 'grab',
        userSelect: 'none',
        borderBottom: minimized ? 'none' : '1px solid var(--t-divider-subtle)',
        flexShrink: 0,
      }}
    >
      {!docked && <GripIcon />}
      <span style={{
        fontSize: 12, fontWeight: 700, color: 'var(--t-text)',
        letterSpacing: '-0.01em', flex: 1,
      }}>
        {title}
      </span>
      {approvalsCount > 0 && (
        <span style={{
          minWidth: 18, height: 18, borderRadius: 9,
          background: '#ef4444', color: '#fff',
          fontSize: 10, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '0 5px', letterSpacing: 0,
          animation: 'pulse 2s ease-in-out infinite',
        }}>
          {approvalsCount}
        </span>
      )}
      {waitingForReply && !minimized && (
        <span style={{
          fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
          padding: '2px 7px', borderRadius: 5,
          background: 'rgba(37,99,235,0.1)',
          color: '#2563eb',
          letterSpacing: '0.03em',
          animation: 'pulse 1.5s ease-in-out infinite',
        }}>
          Thinking...
        </span>
      )}
      {showReset && !minimized && (
        <button type="button" onClick={onReset} title="Clear thread" style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 4,
          color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6, fontSize: 11, fontWeight: 600,
        }}>
          Reset
        </button>
      )}
      {!docked && (
        <>
          <button type="button" onClick={onToggleMinimized} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6,
          }}>
            <MinimizeIcon />
          </button>
          <button type="button" onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: 'var(--t-text-muted)', display: 'flex', borderRadius: 6,
          }}>
            <XIcon />
          </button>
        </>
      )}
    </div>
  );
}
