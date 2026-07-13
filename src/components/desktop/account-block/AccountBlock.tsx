'use client';
/* eslint-disable @next/next/no-img-element -- auth avatar URLs are runtime-provided and intentionally render at a fixed 28px */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { useEntitlement } from '@/lib/entitlement/context';
import { ChromeButton } from '../chrome/ChromeButton';
import { GearSixIcon } from '../desktop-status-bar/status-bar-icons';
import { SettingsQuickDrawer } from '../SettingsQuickDrawer';
import { WhatsNewCard } from './WhatsNewCard';

interface AccountBlockProps {
  onOpenSettings?: () => void;
}

type AccountPopover = 'menu' | 'whats-new' | null;

const NOOP = () => {};

export function AccountBlock({
  onOpenSettings,
}: AccountBlockProps) {
  const { isLoaded, signedIn, user } = useO8Auth();
  const { plan, founder, actualPlan, actualFounder } = useEntitlement();
  const accountRowRef = useRef<HTMLDivElement | null>(null);
  const [popover, setPopover] = useState<AccountPopover>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  // Clerk can fail to finish loading (offline boot, dev-bridge localhost
  // origin) — after a grace window, stop waiting and show the signed-out row
  // so the account block is never a permanently blank strip. signIn() still
  // works: the native flow opens the system browser regardless.
  const [authLoadTimedOut, setAuthLoadTimedOut] = useState(false);
  useEffect(() => {
    if (isLoaded) return undefined;
    const timer = setTimeout(() => setAuthLoadTimedOut(true), 4000);
    return () => clearTimeout(timer);
  }, [isLoaded]);
  const showAccountRow = isLoaded || authLoadTimedOut;

  const hasUser = signedIn && Boolean(user);
  const displayName = user?.name?.trim() || user?.email?.trim() || 'Account';
  const initial = Array.from(displayName)[0]?.toUpperCase() ?? '';
  const isFounder = Boolean(founder || actualFounder) || plan === 'founder' || actualPlan === 'founder';
  const isPaid = plan === 'pro' || plan === 'team' || actualPlan === 'pro' || actualPlan === 'team';
  const planLabel = isFounder ? 'Founder' : isPaid ? 'Pro' : 'Free Plan';
  const openSettings = onOpenSettings ?? NOOP;

  const syncAnchor = useCallback(() => {
    const element = accountRowRef.current;
    setAnchorElement(element);
    setAnchorRect(element?.getBoundingClientRect() ?? null);
  }, []);
  const closePopover = useCallback(() => {
    setPopover(null);
  }, []);
  const toggleMenu = useCallback(() => {
    syncAnchor();
    setPopover((current) => current === 'menu' ? null : 'menu');
  }, [syncAnchor]);
  const openWhatsNew = useCallback(() => {
    syncAnchor();
    setPopover('whats-new');
  }, [syncAnchor]);

  useEffect(() => {
    if (!popover) return;
    const handleViewportChange = () => syncAnchor();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [popover, syncAnchor]);

  return (
    <div
      style={{
        flexShrink: 0,
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider)',
        background: 'transparent',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <div
        ref={accountRowRef}
        style={{
          height: 44,
          display: 'flex',
          alignItems: 'center',
          paddingTop: 0,
          paddingRight: 12,
          paddingBottom: 0,
          paddingLeft: 12,
          boxSizing: 'border-box',
        }}
      >
        {showAccountRow ? (
          <>
            <button
              type="button"
              // Cursor behavior (operator ruling 2026-07-13): clicking the
              // account row opens the menu in EVERY auth state — the menu
              // carries Sign in when signed out, so the drawer is always one
              // click and sign-in stays reachable through it.
              onClick={toggleMenu}
              aria-label={hasUser ? `Open account menu for ${displayName}` : 'Open account menu'}
              aria-haspopup="menu"
              aria-expanded={popover === 'menu'}
              style={{
                minWidth: 0,
                height: 44,
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                paddingTop: 0,
                paddingRight: 8,
                paddingBottom: 0,
                paddingLeft: 0,
                borderWidth: 0,
                background: 'transparent',
                color: 'var(--t-text)',
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              {hasUser && user?.avatarUrl && user.avatarUrl !== failedAvatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  width={28}
                  height={28}
                  onError={() => setFailedAvatarUrl(user.avatarUrl)}
                  style={{
                    width: 28,
                    height: 28,
                    flexShrink: 0,
                    borderRadius: '50%',
                    objectFit: 'cover',
                  }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    width: 28,
                    height: 28,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    borderRadius: '50%',
                    background: 'var(--t-input-bg)',
                    color: 'var(--t-text-muted)',
                    fontSize: 12,
                    fontWeight: 500,
                    letterSpacing: '-0.1px',
                    lineHeight: 1,
                  }}
                >
                  {hasUser ? initial : ''}
                </span>
              )}
              <span style={{ minWidth: 0, flex: 1 }}>
                <span
                  style={{
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--t-text)',
                    fontSize: 13.5,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                    lineHeight: 1.25,
                  }}
                >
                  {hasUser ? displayName : 'Sign in'}
                </span>
                <span
                  style={{
                    display: 'block',
                    marginTop: 4,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--t-text-muted)',
                    fontSize: 9.5,
                    fontWeight: 260,
                    letterSpacing: '-0.4px',
                    lineHeight: 1.25,
                  }}
                >
                  {hasUser ? planLabel : 'Sync your account'}
                </span>
              </span>
            </button>
            <ChromeButton
              icon={<GearSixIcon size={14} color="var(--t-text-muted)" />}
              label="Account settings"
              active={popover !== null}
              onClick={toggleMenu}
              size={22}
              radius={6}
            />
          </>
        ) : null}
      </div>

      {/* The account click opens the FULL quick-settings drawer (operator
          ruling 2026-07-13: "we still wanted our settings modal from old") —
          account section, Settings ⌘,, theme, usage, updates, What's new,
          Get help, MCP setup. The slimmer AccountMenu is retired in favor of
          this superset; sign in/out live in the drawer's account section. */}
      <SettingsQuickDrawer
        open={popover === 'menu' && anchorRect !== null}
        anchorRect={anchorRect}
        onClose={closePopover}
        onOpenSettings={() => {
          closePopover();
          openSettings();
        }}
        onWhatsNew={openWhatsNew}
      />
      {popover === 'whats-new' && anchorRect ? (
        <WhatsNewCard
          anchorRect={anchorRect}
          anchorElement={anchorElement}
          onClose={closePopover}
        />
      ) : null}
    </div>
  );
}
