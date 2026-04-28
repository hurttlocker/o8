'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  MOBILE_BODY_TRACKING,
  MOBILE_CARD_RADIUS,
  MOBILE_TOUCH_TARGET,
  mobileFontFamily,
  type MobilePalette,
} from '@/app/mobile/mobile-approvals-shared';
import { mobileSafeBottom } from '@/app/mobile/mobile-shell-primitives';
import { ICON_BELL, ICON_PLUG } from './icons';
import { Row, SectionCard, SectionLabel, ToggleRow } from './primitives';
import {
  detectPushSupport,
  enablePush,
  disablePush,
  isPushEnabled,
  sendTestPush,
  readStoredPushEnabled,
} from '@/lib/mobile/push-client';

type Status =
  | { kind: 'idle' }
  | { kind: 'enabling' }
  | { kind: 'disabling' }
  | { kind: 'testing' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

const WEBHOOK_URL_STORAGE_KEY = 'o8:mobile:push:webhook-url';

function readStoredWebhookUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(WEBHOOK_URL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function NotificationsSubView({ palette }: { palette: MobilePalette }) {
  // Lazy initialisers compute support detection + initial permission state
  // synchronously at first render so we don't have to setState in an effect.
  const [initialSupport] = useState(() => detectPushSupport());
  const [enabled, setEnabled] = useState<boolean>(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (!initialSupport.ok) return 'unsupported';
    return typeof Notification !== 'undefined' ? Notification.permission : 'default';
  });
  const supportReason = initialSupport.ok ? null : initialSupport.reason;
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [webhookUrl, setWebhookUrl] = useState<string>(readStoredWebhookUrl);
  const [webhookSaving, setWebhookSaving] = useState<boolean>(false);

  useEffect(() => {
    if (!initialSupport.ok) return;
    let cancelled = false;
    void (async () => {
      const active = await isPushEnabled();
      if (cancelled) return;
      const stored = readStoredPushEnabled();
      setEnabled(active && stored);
    })();
    return () => {
      cancelled = true;
    };
  }, [initialSupport.ok]);

  const handleToggle = useCallback(async (next: boolean) => {
    if (next) {
      setStatus({ kind: 'enabling' });
      const result = await enablePush();
      if (result.ok) {
        setEnabled(true);
        setPermission('granted');
        setStatus({ kind: 'success', message: 'Notifications enabled.' });
      } else {
        setEnabled(false);
        if (result.reason === 'denied') {
          setPermission('denied');
          setStatus({
            kind: 'error',
            message: 'Notification permission was declined. Re-enable from your browser settings, then try again.',
          });
        } else {
          setStatus({
            kind: 'error',
            message: `Could not enable push: ${result.detail ?? result.reason}.`,
          });
        }
      }
      return;
    }

    setStatus({ kind: 'disabling' });
    await disablePush();
    setEnabled(false);
    setStatus({ kind: 'success', message: 'Notifications disabled.' });
  }, []);

  const handleTest = useCallback(async () => {
    setStatus({ kind: 'testing' });
    const result = await sendTestPush();
    if (result.ok) {
      setStatus({
        kind: 'success',
        message: `Sent. Delivered ${result.delivered ?? 0}, failed ${result.failed ?? 0}.`,
      });
    } else {
      setStatus({
        kind: 'error',
        message: `Test failed: ${result.detail ?? 'unknown error'}.`,
      });
    }
  }, []);

  const handleWebhookSave = useCallback(async () => {
    setWebhookSaving(true);
    setStatus({ kind: 'idle' });
    const trimmed = webhookUrl.trim();
    try {
      if (trimmed) {
        window.localStorage.setItem(WEBHOOK_URL_STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(WEBHOOK_URL_STORAGE_KEY);
      }
      setStatus({
        kind: 'success',
        message: trimmed ? 'Webhook URL saved on this device.' : 'Webhook URL cleared.',
      });
    } catch {
      setStatus({ kind: 'error', message: 'Could not save webhook URL.' });
    }
    setWebhookSaving(false);
  }, [webhookUrl]);

  const supportLabel = (() => {
    switch (supportReason) {
      case 'tauri': return 'Push is handled natively on desktop. This toggle only applies to the mobile PWA.';
      case 'unsupported': return 'This browser does not support Web Push notifications. Add o8 to your home screen on iOS 16.4+ or Android, or use the webhook fallback below.';
      case 'no-window': return null;
      default: return null;
    }
  })();

  const isBusy = status.kind === 'enabling' || status.kind === 'disabling' || status.kind === 'testing';

  return (
    <div style={{ paddingTop: 8, paddingBottom: mobileSafeBottom(24) }}>
      <SectionLabel palette={palette}>Push notifications</SectionLabel>
      <SectionCard palette={palette}>
        <ToggleRow
          iconPath={ICON_BELL}
          label="Enable push"
          value={enabled}
          onChange={(next) => void handleToggle(next)}
          palette={palette}
          showDivider
        />
        <Row
          iconPath={ICON_BELL}
          label="Send test notification"
          rightValue={isBusy ? '...' : ''}
          onClick={() => {
            if (!isBusy) void handleTest();
          }}
          palette={palette}
          showChevron={false}
          showDivider={false}
        />
      </SectionCard>

      {permission === 'denied' ? (
        <div
          style={{
            margin: 12,
            padding: '12px 14px',
            borderRadius: MOBILE_CARD_RADIUS,
            border: `1px solid ${palette.dangerBorder}`,
            background: palette.dangerSoft,
            fontSize: 13,
            color: palette.rootText,
            lineHeight: 1.6,
            letterSpacing: MOBILE_BODY_TRACKING,
          }}
        >
          Browser permission is set to {'"'}Block{'"'}. Open Safari or Chrome settings for this site and switch notifications to {'"'}Allow{'"'}, then re-enable here.
        </div>
      ) : null}

      {supportLabel ? (
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
          {supportLabel}
        </div>
      ) : null}

      <SectionLabel palette={palette}>Webhook fallback</SectionLabel>
      <SectionCard palette={palette}>
        <div
          style={{
            paddingTop: 14,
            paddingBottom: 14,
            paddingLeft: 16,
            paddingRight: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              color: palette.rootText,
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width={22} height={22} viewBox="0 0 256 256" aria-hidden="true">
                <path d={ICON_PLUG} fill={palette.iconFill} />
              </svg>
            </div>
            <span
              style={{
                fontSize: 15,
                fontWeight: 500,
                letterSpacing: MOBILE_BODY_TRACKING,
              }}
            >
              ntfy.sh / Pushover URL
            </span>
          </div>
          <input
            type="url"
            inputMode="url"
            placeholder="https://ntfy.sh/your-topic"
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
            style={{
              width: '100%',
              minHeight: MOBILE_TOUCH_TARGET,
              borderRadius: MOBILE_CARD_RADIUS,
              border: `1px solid ${palette.inputBorder}`,
              background: palette.inputBackground,
              color: palette.rootText,
              fontSize: 15,
              fontFamily: mobileFontFamily(),
              letterSpacing: MOBILE_BODY_TRACKING,
              paddingTop: 0,
              paddingBottom: 0,
              paddingLeft: 12,
              paddingRight: 12,
              outline: 'none',
            }}
          />
          <div
            style={{
              fontSize: 12,
              color: palette.subduedText,
              lineHeight: 1.6,
              letterSpacing: MOBILE_BODY_TRACKING,
            }}
          >
            Saved on this device only. Wire this up by registering a subscription with this URL — the API still requires the bearer token.
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={() => void handleWebhookSave()}
              disabled={webhookSaving}
              style={{
                flex: 1,
                minHeight: MOBILE_TOUCH_TARGET,
                borderRadius: MOBILE_CARD_RADIUS,
                border: `1px solid ${palette.accentBorder}`,
                background: palette.accentSoft,
                color: palette.accent,
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: MOBILE_BODY_TRACKING,
                fontFamily: mobileFontFamily(),
                cursor: 'pointer',
              }}
            >
              {webhookSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </SectionCard>

      {status.kind === 'success' || status.kind === 'error' ? (
        <div
          style={{
            margin: 12,
            padding: '12px 16px',
            borderRadius: MOBILE_CARD_RADIUS,
            border: `1px solid ${status.kind === 'error' ? palette.dangerBorder : palette.cardBorder}`,
            background: status.kind === 'error' ? palette.dangerSoft : palette.panelElevated,
            fontSize: 13,
            color: palette.rootText,
            lineHeight: 1.6,
            letterSpacing: MOBILE_BODY_TRACKING,
          }}
        >
          {status.message}
        </div>
      ) : null}
    </div>
  );
}
