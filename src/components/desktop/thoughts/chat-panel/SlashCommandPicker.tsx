'use client';

interface SlashCommandPickerProps {
  input: string;
  isOrchestratorMode: boolean;
  onSelect: (cmd: string) => void;
}

const SLASH_COMMANDS = [
  { cmd: '/compact', title: 'Compact context', desc: 'Compress conversation history to free up space' },
  { cmd: '/clear', title: 'Clear conversation', desc: 'Reset the current conversation' },
  { cmd: '/cost', title: 'Token usage', desc: 'Show token count and estimated cost' },
  { cmd: '/status', title: 'Session status', desc: 'Show current session info and state' },
  { cmd: '/review', title: 'Code review', desc: 'Review current uncommitted changes' },
  { cmd: '/help', title: 'Help', desc: 'Show available commands and usage' },
];

export function SlashCommandPicker({ input, isOrchestratorMode, onSelect }: SlashCommandPickerProps) {
  const showSlashPicker = isOrchestratorMode && input.startsWith('/') && !input.includes(' ');
  if (!showSlashPicker) return null;
  const query = input.toLowerCase();
  const filtered = SLASH_COMMANDS.filter(c => c.cmd.startsWith(query));
  if (filtered.length === 0) return null;

  return (
    <div className="thoughts-scroll" style={{
      position: 'absolute',
      bottom: '100%',
      left: 0,
      right: 0,
      marginBottom: 6,
      maxHeight: 220,
      overflowY: 'auto',
      borderRadius: 14,
      padding: 4,
      background: 'var(--t-panel-translucent)',
      backdropFilter: 'blur(28px) saturate(180%)',
      WebkitBackdropFilter: 'blur(28px) saturate(180%)',
      border: '1px solid var(--t-panel-border)',
      boxShadow: 'var(--t-panel-shadow)',
      zIndex: 10,
    }}>
      <div style={{
        fontSize: 9,
        fontWeight: 700,
        textTransform: 'uppercase',
        color: 'var(--t-text-muted)',
        letterSpacing: '0.05em',
        padding: '6px 10px 4px',
      }}>
        Commands
      </div>
      {filtered.map((c) => (
        <button
          key={c.cmd}
          type="button"
          onClick={() => onSelect(c.cmd)}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 10,
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            background: 'transparent',
          }}
        >
          <span style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--t-accent, #2563eb)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            flexShrink: 0,
          }}>
            {c.cmd}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>{c.title}</div>
            <div style={{ fontSize: 10, color: 'var(--t-text-muted)', marginTop: 1 }}>{c.desc}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
