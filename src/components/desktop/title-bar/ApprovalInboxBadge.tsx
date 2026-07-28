'use client';

interface ApprovalInboxBadgeProps {
  count: number;
  onClick: () => void;
}

function ApprovalShieldIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M12 3 20 6.5v5.3c0 4.3-3.1 7.7-8 9.2-4.9-1.5-8-4.9-8-9.2V6.5L12 3Z" />
      <path d="M9 12.2 11.2 14.4 15.5 9.6" />
    </svg>
  );
}

export function ApprovalInboxBadge({ count, onClick }: ApprovalInboxBadgeProps) {
  if (count <= 0) return null;

  const label = `${count} pending approval${count === 1 ? '' : 's'}. Open Inbox.`;

  return (
    <button
      type="button"
      data-no-drag
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        height: 26,
        minWidth: 42,
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 8,
        borderRadius: 7,
        border: '1px solid color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 72%, var(--t-divider-subtle))',
        background: 'var(--t-brand-orange, #FF5A1F)',
        color: 'var(--t-brand-orange-contrast)',
        boxShadow: '0 0 0 1px color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 30%, transparent), 0 0 18px color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 34%, transparent)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '-0.1px',
        lineHeight: 1,
        flexShrink: 0,
        transition: 'filter 120ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.filter = 'brightness(1.05)';
        event.currentTarget.style.boxShadow = '0 0 0 1px color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 42%, transparent), 0 0 22px color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 48%, transparent)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.filter = 'none';
        event.currentTarget.style.boxShadow = '0 0 0 1px color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 30%, transparent), 0 0 18px color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 34%, transparent)';
      }}
    >
      <span aria-hidden style={{ position: 'absolute', top: -14, bottom: -4, left: 0, right: 0 }} />
      <ApprovalShieldIcon size={13} />
      <span style={{ minWidth: 10, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        {count > 99 ? '99+' : count}
      </span>
    </button>
  );
}
