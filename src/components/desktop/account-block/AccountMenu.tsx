'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { openExternalUrl } from '@/lib/desktop/open-external';

interface AccountMenuProps {
  anchorRect: DOMRect;
  anchorElement: HTMLElement | null;
  signedIn: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenWhatsNew: () => void;
  onSignIn: () => void;
  onSignOut: () => Promise<void>;
}

const MENU_WIDTH = 218;

const menuItemStyle: CSSProperties = {
  width: '100%',
  minHeight: 30,
  display: 'flex',
  alignItems: 'center',
  paddingTop: 6,
  paddingRight: 9,
  paddingBottom: 6,
  paddingLeft: 9,
  borderWidth: 0,
  borderRadius: 7,
  background: 'transparent',
  color: 'var(--t-text)',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans-system)',
  fontSize: 12,
  fontWeight: 400,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
  textAlign: 'left',
};

export function AccountMenu({
  anchorRect,
  anchorElement,
  signedIn,
  onClose,
  onOpenSettings,
  onOpenWhatsNew,
  onSignIn,
  onSignOut,
}: AccountMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('button');
    firstItem?.focus();
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || menuRef.current?.contains(target) || anchorElement?.contains(target)) return;
      onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [anchorElement, onClose]);

  const left = typeof window === 'undefined'
    ? anchorRect.left + 8
    : Math.max(8, Math.min(anchorRect.left + 8, window.innerWidth - MENU_WIDTH - 8));
  const bottom = typeof window === 'undefined' ? 56 : window.innerHeight - anchorRect.top + 6;
  const run = (action: () => void) => {
    onClose();
    action();
  };
  const openMcpSetup = () => {
    onClose();
    onOpenSettings();
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_TAB_EVENT, { detail: { tab: 'mcp' } }));
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Account menu"
      tabIndex={-1}
      style={{
        position: 'fixed',
        left,
        bottom,
        width: MENU_WIDTH,
        paddingTop: 5,
        paddingRight: 5,
        paddingBottom: 5,
        paddingLeft: 5,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        borderRadius: 10,
        background: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow)',
        fontFamily: 'var(--font-sans-system)',
        outline: 'none',
        zIndex: 1300,
      }}
    >
      <MenuItem label="Settings" onClick={() => run(onOpenSettings)} />
      <MenuItem label="Get help" onClick={() => run(() => openExternalUrl('https://o8.run/docs'))} />
      <MenuItem label="MCP setup" onClick={openMcpSetup} />
      <MenuItem label="What's new" onClick={onOpenWhatsNew} />
      <div
        aria-hidden="true"
        style={{
          height: 1,
          marginTop: 4,
          marginRight: 4,
          marginBottom: 4,
          marginLeft: 4,
          background: 'var(--t-divider)',
        }}
      />
      <MenuItem
        label={signedIn ? 'Sign out' : 'Sign in'}
        onClick={() => {
          onClose();
          if (signedIn) void onSignOut();
          else onSignIn();
        }}
      />
    </div>,
    document.body,
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={menuItemStyle}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'var(--t-panel-active)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
      onFocus={(event) => {
        event.currentTarget.style.background = 'var(--t-panel-active)';
      }}
      onBlur={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
    </button>
  );
}
