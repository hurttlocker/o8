'use client';

import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_HEADING_TRACKING,
  MOBILE_TOUCH_TARGET,
  formatAboutVersion,
  mobileFontFamily,
  type MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';
import { mobileSafeBottom } from '@/app/mobile/mobile-shell-primitives';
import {
  ICON_BELL,
  ICON_CHART,
  ICON_INFO,
  ICON_LOCK,
  ICON_PALETTE,
  ICON_PLUG,
  ICON_SHIELD_CHECK,
  ICON_SLIDERS,
  ICON_USER,
  ICON_X,
} from './settings-sheet/icons';
import { Icon, Row, SectionCard, SectionLabel, SubViewHeader } from './settings-sheet/primitives';
import {
  AppearanceSubView,
  CapabilitiesSubView,
  ConnectorsSubView,
  PermissionsSubView,
  PrivacySubView,
  ProfileSubView,
  UsageSubView,
} from './settings-sheet/sub-views';
import { NotificationsSubView } from './settings-sheet/notifications-sub-view';

/* ─────────────────────────────────────────────────────────────────────────
 * MobileSettingsSheet
 *
 * Mirror of Anthropic's mobile profile-button + Settings sheet pattern:
 *   - small profile pill at the bottom of the drawer (built in sidebar)
 *   - tap → this slide-up sheet renders
 *   - header (X close / "Settings" / info), identity pill, sections A-D
 *   - rows have a sub-view system (Profile, Usage, Capabilities, Permissions,
 *     Appearance, Privacy) — sub-views render inside the same sheet shell
 *
 * Sections that don't apply to o8 (local-first) are skipped: billing,
 * speech, notifications, shared links, log out.
 * ──────────────────────────────────────────────────────────────────────── */

type SubView =
  | 'root'
  | 'profile'
  | 'usage'
  | 'capabilities'
  | 'connectors'
  | 'permissions'
  | 'appearance'
  | 'notifications'
  | 'privacy';

interface MobileSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  themeId: string;
  onThemeChange: (theme: 'light' | 'dark') => void;
  appVersion: string;
  hostnameLabel: string;
  palette: MobilePalette;
}

function RootView({
  hostnameLabel,
  appVersion,
  themeId,
  onSubViewChange,
  palette,
}: {
  hostnameLabel: string;
  appVersion: string;
  themeId: string;
  onSubViewChange: (next: SubView) => void;
  palette: MobilePalette;
}) {
  const initials = useMemo(() => {
    const trimmed = hostnameLabel.replace(/[^a-zA-Z0-9]/g, '');
    return trimmed.slice(0, 2).toUpperCase() || 'O8';
  }, [hostnameLabel]);
  const versionLabel = formatAboutVersion(appVersion);

  return (
    <div style={{ paddingBottom: mobileSafeBottom(24) }}>
      {/* Identity pill */}
      <div
        style={{
          marginTop: 18,
          marginLeft: 12,
          marginRight: 12,
          padding: 14,
          borderRadius: MOBILE_CARD_RADIUS,
          background: palette.panelElevated,
          border: `1px solid ${palette.cardBorder}`,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            minWidth: 48,
            minHeight: 48,
            borderRadius: 999,
            background: palette.accentSoft,
            border: `1px solid ${palette.accentBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: palette.accent,
            fontSize: 16,
            fontWeight: 800,
            letterSpacing: MOBILE_HEADING_TRACKING,
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: palette.rootText,
              letterSpacing: MOBILE_BODY_TRACKING,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {hostnameLabel}
          </div>
          <div
            style={{
              fontSize: 12,
              color: palette.subduedText,
              letterSpacing: MOBILE_BODY_TRACKING,
              marginTop: 2,
            }}
          >
            o8 · v{versionLabel}
          </div>
        </div>
      </div>

      <SectionLabel palette={palette}>Account</SectionLabel>
      <SectionCard palette={palette}>
        <Row
          iconPath={ICON_USER}
          label="Profile"
          onClick={() => onSubViewChange('profile')}
          palette={palette}
        />
        <Row
          iconPath={ICON_CHART}
          label="Usage"
          onClick={() => onSubViewChange('usage')}
          palette={palette}
          showDivider={false}
        />
      </SectionCard>

      <SectionLabel palette={palette}>Capabilities</SectionLabel>
      <SectionCard palette={palette}>
        <Row
          iconPath={ICON_SLIDERS}
          label="Capabilities"
          onClick={() => onSubViewChange('capabilities')}
          palette={palette}
        />
        <Row
          iconPath={ICON_PLUG}
          label="Connectors"
          onClick={() => onSubViewChange('connectors')}
          palette={palette}
        />
        <Row
          iconPath={ICON_SHIELD_CHECK}
          label="Permissions"
          onClick={() => onSubViewChange('permissions')}
          palette={palette}
          showDivider={false}
        />
      </SectionCard>

      <SectionLabel palette={palette}>Preferences</SectionLabel>
      <SectionCard palette={palette}>
        <Row
          iconPath={ICON_PALETTE}
          label="Appearance"
          rightValue={themeId === 'light' ? 'Light' : 'Dark'}
          onClick={() => onSubViewChange('appearance')}
          palette={palette}
        />
        <Row
          iconPath={ICON_BELL}
          label="Notifications"
          onClick={() => onSubViewChange('notifications')}
          palette={palette}
        />
        <Row
          iconPath={ICON_LOCK}
          label="Privacy"
          onClick={() => onSubViewChange('privacy')}
          palette={palette}
          showDivider={false}
        />
      </SectionCard>
    </div>
  );
}

export function MobileSettingsSheet({
  open,
  onClose,
  themeId,
  onThemeChange,
  appVersion,
  hostnameLabel,
  palette,
}: MobileSettingsSheetProps) {
  const [subView, setSubView] = useState<SubView>('root');
  const [showInfo, setShowInfo] = useState(false);

  // Sheet always lands on the root view. We reset on close + on every
  // sub-view back press, so reopening picks up a clean root view without
  // an effect (avoids set-state-in-effect cascades).
  const handleClose = useCallback(() => {
    setSubView('root');
    setShowInfo(false);
    onClose();
  }, [onClose]);

  const subViewTitle = useMemo(() => {
    switch (subView) {
      case 'profile':
        return 'Profile';
      case 'usage':
        return 'Usage';
      case 'capabilities':
        return 'Capabilities';
      case 'connectors':
        return 'Connectors';
      case 'permissions':
        return 'Permissions';
      case 'appearance':
        return 'Appearance';
      case 'notifications':
        return 'Notifications';
      case 'privacy':
        return 'Privacy';
      default:
        return 'Settings';
    }
  }, [subView]);

  if (!open) {
    return (
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          pointerEvents: 'none',
          opacity: 0,
        }}
      />
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Settings"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: palette.rootBackground,
        color: palette.rootText,
        fontFamily: mobileFontFamily(),
        letterSpacing: MOBILE_BODY_TRACKING,
        display: 'flex',
        flexDirection: 'column',
        animation: 'mobileSettingsSheetIn 0.28s cubic-bezier(0.32, 0.72, 0, 1)',
      } as CSSProperties}
    >
      <style>{`
        @keyframes mobileSettingsSheetIn {
          from { transform: translateY(24px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>

      {subView === 'root' ? (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 2,
            background: palette.sidebarBackground,
            borderBottom: `1px solid ${palette.cardBorder}`,
            paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)',
            paddingLeft: 4,
            paddingRight: 4,
            paddingBottom: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
          }}
        >
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close settings"
            style={{
              width: MOBILE_TOUCH_TARGET,
              height: MOBILE_TOUCH_TARGET,
              minWidth: MOBILE_TOUCH_TARGET,
              minHeight: MOBILE_TOUCH_TARGET,
              borderRadius: 999,
              background: 'transparent',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: palette.rootText,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <Icon d={ICON_X} fill={palette.iconFill} size={20} />
          </button>
          <div
            style={{
              flex: 1,
              fontSize: 17,
              fontWeight: 700,
              textAlign: 'center',
              letterSpacing: MOBILE_HEADING_TRACKING,
              color: palette.rootText,
            }}
          >
            Settings
          </div>
          <button
            type="button"
            onClick={() => setShowInfo((value) => !value)}
            aria-label="About settings"
            style={{
              width: MOBILE_TOUCH_TARGET,
              height: MOBILE_TOUCH_TARGET,
              minWidth: MOBILE_TOUCH_TARGET,
              minHeight: MOBILE_TOUCH_TARGET,
              borderRadius: 999,
              background: 'transparent',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: palette.rootText,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <Icon d={ICON_INFO} fill={palette.iconFill} size={20} />
          </button>
        </div>
      ) : (
        <SubViewHeader
          title={subViewTitle}
          onBack={() => setSubView('root')}
          palette={palette}
        />
      )}

      {showInfo && subView === 'root' ? (
        <div
          style={{
            margin: 12,
            padding: '12px 14px',
            borderRadius: MOBILE_CARD_RADIUS,
            border: `1px solid ${palette.cardBorder}`,
            background: palette.panelElevated,
            fontSize: 13,
            color: palette.subduedText,
            lineHeight: 1.6,
            letterSpacing: MOBILE_BODY_TRACKING,
          }}
        >
          o8 is local-first. There is no cloud account — settings live on this device only.
        </div>
      ) : null}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
        } as CSSProperties}
      >
        {subView === 'root' ? (
          <RootView
            hostnameLabel={hostnameLabel}
            appVersion={appVersion}
            themeId={themeId}
            onSubViewChange={setSubView}
            palette={palette}
          />
        ) : null}

        {subView === 'profile' ? (
          <ProfileSubView
            hostnameLabel={hostnameLabel}
            appVersion={appVersion}
            palette={palette}
          />
        ) : null}

        {subView === 'usage' ? <UsageSubView palette={palette} /> : null}

        {subView === 'capabilities' ? <CapabilitiesSubView palette={palette} /> : null}

        {subView === 'connectors' ? <ConnectorsSubView palette={palette} /> : null}

        {subView === 'permissions' ? <PermissionsSubView palette={palette} /> : null}

        {subView === 'appearance' ? (
          <AppearanceSubView
            themeId={themeId}
            onThemeChange={onThemeChange}
            palette={palette}
          />
        ) : null}

        {subView === 'notifications' ? <NotificationsSubView palette={palette} /> : null}

        {subView === 'privacy' ? <PrivacySubView palette={palette} /> : null}
      </div>
    </div>
  );
}
