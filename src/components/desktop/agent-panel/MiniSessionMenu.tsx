'use client';

import { Sparkles, Terminal, type LucideIcon } from '../lucide-shims';

export function MiniSessionMenu({
  onCreateOrchestrator,
  onCreateTerminal,
}: {
  onCreateOrchestrator: () => void;
  onCreateTerminal: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 0,
        marginRight: 0,
        marginBottom: 2,
        marginLeft: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        borderRadius: 0,
        border: 0,
        background: 'transparent',
        overflow: 'visible',
      }}
    >
      <MiniSessionMenuItem
        icon={Sparkles}
        title="Orchestrator"
        subtitle="Fleet by default"
        onClick={onCreateOrchestrator}
      />
      <MiniSessionMenuItem
        icon={Terminal}
        title="Terminal"
        subtitle="Plain shell"
        onClick={onCreateTerminal}
      />
    </div>
  );
}

function MiniSessionMenuItem({
  icon: Icon,
  title,
  subtitle,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: 'calc(100% - 16px)',
        marginLeft: 8,
        marginRight: 8,
        borderWidth: 0,
        borderBottom: 0,
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        outline: 'none',
        display: 'grid',
        gridTemplateColumns: '21px minmax(0, 1fr)',
        gap: 10,
        alignItems: 'center',
        paddingTop: 7,
        paddingRight: 10,
        paddingBottom: 7,
        paddingLeft: 10,
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        // Instant flat hover — matches the terminal toggle pattern.
        // No row divider or fade transition (operator pass 2026-05-27).
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'var(--t-hover)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <span
        aria-hidden
        style={{
          width: 21,
          height: 21,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--t-accent)',
        }}
      >
        <Icon size={14} strokeWidth={1.9} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13.5,
            lineHeight: 1.25,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 4,
            fontSize: 9.5,
            lineHeight: 1.25,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            color: 'var(--t-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subtitle}
        </span>
      </span>
    </button>
  );
}
