import { memo, type CSSProperties, type ReactNode } from 'react';
import type { TopBarProps } from './types';
import { SpeedDialButton } from './SpeedDial';
import { useTheme } from './ThemeContext';

const fontFamily = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif";

const topVeilStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: '50%',
  width: 'min(100dvw, 430px)',
  height: 'calc(env(safe-area-inset-top, 0px) + 118px)',
  transform: 'translateX(-50%)',
  background: 'linear-gradient(180deg, rgba(0, 0, 0, 0.96) 0%, rgba(0, 0, 0, 0.9) 30%, rgba(0, 0, 0, 0.68) 58%, rgba(0, 0, 0, 0.24) 82%, rgba(0, 0, 0, 0) 100%)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  pointerEvents: 'none',
  zIndex: 10,
};

function BackIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 18 9 12l6-6" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </svg>
  );
}

function HeaderIconButton({
  label,
  onClick,
  children,
  style,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  style: CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={style}
    >
      {children}
    </button>
  );
}

function screenTitle(activeView: TopBarProps['activeView']) {
  switch (activeView) {
    case 'fleet':
      return 'Agents';
    case 'memory':
      return 'Memory';
    case 'activity':
      return 'Activity';
    case 'settings':
      return 'Settings';
    case 'issues':
      return 'Issues';
    case 'costs':
      return 'Costs';
    default:
      return 'Code';
  }
}

export const TopBar = memo(function TopBar({
  selectedSession,
  headerVisible,
  pendingApprovalsCount,
  activeView,
  compactLine,
  activeScreen,
  onNavigate,
  onBackToIndex,
  onOpenControls,
}: TopBarProps) {
  const { colors } = useTheme();

  if (activeView !== 'squad' && activeView !== 'chat') {
    return null;
  }

  const isThreadView = activeView === 'chat';
  const primaryText = '#F5F5F7';
  const secondaryText = '#8E8E93';
  const chromeBackground = 'rgba(0, 0, 0, 0.8)';
  const chromeBorder = 'rgba(255, 255, 255, 0.08)';
  const threadTitle = compactLine(
    selectedSession?.currentTask ?? selectedSession?.name,
    selectedSession?.name ?? 'Code',
    30,
  );
  const headerStyle: CSSProperties = {
    position: 'fixed',
    top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
    left: '50%',
    width: 'min(calc(100dvw - 28px), 390px)',
    transform: headerVisible ? 'translate(-50%, 0)' : 'translate(-50%, -10px)',
    display: 'grid',
    gridTemplateColumns: '44px minmax(0, 1fr) 44px',
    alignItems: 'center',
    gap: 12,
    zIndex: 12,
    opacity: headerVisible ? 1 : 0,
    pointerEvents: headerVisible ? 'auto' : 'none',
    transition: 'opacity 220ms ease, transform 220ms ease',
    background: 'transparent',
  };
  const iconButtonStyle: CSSProperties = {
    width: 44,
    height: 44,
    minWidth: 44,
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${chromeBorder}`,
    borderRadius: 999,
    background: chromeBackground,
    color: primaryText,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    boxShadow: '0 12px 28px rgba(0, 0, 0, 0.32)',
    cursor: 'pointer',
    padding: 0,
    outlineColor: colors.blueAccent,
    outlineOffset: 2,
    WebkitTapHighlightColor: 'transparent',
  };
  const copyStyle: CSSProperties = {
    minWidth: 0,
    textAlign: 'center',
  };
  const titleStyle: CSSProperties = {
    margin: 0,
    color: primaryText,
    fontFamily,
    fontSize: '1.06rem',
    fontWeight: 700,
    letterSpacing: '-0.025em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
  const subtitleStyle: CSSProperties = {
    margin: '2px 0 0',
    color: secondaryText,
    fontFamily,
    fontSize: '0.74rem',
    fontWeight: 500,
    letterSpacing: '-0.01em',
  };
  const spacerStyle: CSSProperties = {
    display: 'block',
    width: 44,
    height: 44,
    opacity: 0,
    pointerEvents: 'none',
  };

  return (
    <>
      <div style={topVeilStyle} aria-hidden="true" />
      <header style={headerStyle}>
        {isThreadView ? (
          <HeaderIconButton
            label="Back to code list"
            onClick={onBackToIndex}
            style={iconButtonStyle}
          >
            <BackIcon />
          </HeaderIconButton>
        ) : (
          <SpeedDialButton
            activeScreen={activeScreen}
            onNavigate={onNavigate}
            approvalCount={pendingApprovalsCount}
          />
        )}

        <div style={copyStyle}>
          <h1 style={titleStyle}>{isThreadView ? threadTitle : screenTitle(activeView)}</h1>
          {isThreadView ? <p style={subtitleStyle}>Remote control</p> : null}
        </div>

        {isThreadView ? (
          <HeaderIconButton
            label="Open thread controls"
            onClick={onOpenControls}
            style={iconButtonStyle}
          >
            <MoreIcon />
          </HeaderIconButton>
        ) : (
          <span style={spacerStyle} aria-hidden="true" />
        )}
      </header>
    </>
  );
});
