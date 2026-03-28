import { SendIcon, SparklesIcon } from './ThoughtsIcons';

export function InputButtons({
  input,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  small,
}: {
  input: string;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSubmit: () => void;
  small?: boolean;
}) {
  const sz = small ? 24 : 28;
  const sendSz = small ? 26 : 30;

  return (
    <div style={{
      position: 'absolute',
      right: 10,
      bottom: 10,
      display: 'flex',
      gap: 6,
      alignItems: 'center',
    }}>
      {preEnhanceInput !== null && (
        <button type="button" onClick={onUndoEnhance} title="Undo enhancement" style={{
          width: sz, height: sz, borderRadius: 7, border: 'none',
          background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 600,
        }}>
          ↩
        </button>
      )}
      <button type="button" onClick={onEnhance} disabled={!input.trim() || enhancing}
        title="Enhance with AI" style={{
          width: sz, height: sz, borderRadius: 7, border: 'none',
          background: input.trim() ? 'rgba(37, 99, 235, 0.1)' : 'var(--t-hover)',
          color: enhancing ? '#93c5fd' : input.trim() ? '#2563eb' : 'var(--t-text-faint)',
          cursor: input.trim() && !enhancing ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'background 120ms, color 120ms',
          animation: enhancing ? 'spin 1.5s ease-in-out infinite' : 'none',
        }}>
        <SparklesIcon />
      </button>
      <button type="button" onClick={onSubmit} disabled={!input.trim()} style={{
        width: sendSz, height: sendSz, borderRadius: 8, border: 'none',
        background: input.trim() ? '#2563eb' : 'var(--t-divider)',
        color: input.trim() ? '#fff' : 'var(--t-text-faint)',
        cursor: input.trim() ? 'pointer' : 'default',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 120ms',
      }}>
        <SendIcon />
      </button>
    </div>
  );
}
