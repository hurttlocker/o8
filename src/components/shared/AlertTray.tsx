'use client';

/**
 * AlertTray — notification center.
 *
 * Desktop: frosted glass dropdown from bell icon.
 * Mobile: full-screen sheet (slides up from bottom).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCircle2,
  ChevronRight,
  Clock,
  Gauge,
  ShieldCheck,
  WifiOff,
  X,
} from 'lucide-react';
import type { Alert, AlertType } from '@/lib/alerts/types';
import { SEVERITY_COLOR } from '@/lib/alerts/types';

const ICON_MAP: Record<AlertType, typeof Bell> = {
  stuck: Clock,
  approval: ShieldCheck,
  completed: CheckCircle2,
  error: AlertTriangle,
  'context-warn': Gauge,
  'context-critical': Gauge,
  offline: WifiOff,
};

interface AlertTrayProps {
  alerts: Alert[];
  open: boolean;
  onClose: () => void;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
  onAction?: (alert: Alert) => void;
  variant: 'mobile' | 'desktop';
}

const AlertCard = memo(function AlertCard({
  alert,
  onMarkRead,
  onDismiss,
  onAction,
}: {
  alert: Alert;
  onMarkRead: (id: string) => void;
  onDismiss: (id: string) => void;
  onAction?: (alert: Alert) => void;
}) {
  const Icon = ICON_MAP[alert.type] ?? Bell;
  const color = SEVERITY_COLOR[alert.severity];
  const age = formatAge(alert.timestamp);

  return (
    <div
      onClick={() => {
        if (!alert.read) onMarkRead(alert.id);
      }}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 14px',
        borderRadius: 12,
        background: alert.read ? 'transparent' : 'rgba(0, 122, 255, 0.04)',
        transition: 'background 200ms ease',
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      {/* Severity dot + icon */}
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          background: `${color}14`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={16} strokeWidth={2} style={{ color }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: alert.read ? 500 : 600,
              color: '#111827',
              lineHeight: 1.3,
              flex: 1,
            }}
          >
            {alert.title}
          </span>
          {!alert.read ? (
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: color,
                flexShrink: 0,
              }}
            />
          ) : null}
        </div>
        <div
          style={{
            fontSize: 12,
            color: '#8e8e93',
            lineHeight: 1.4,
            marginTop: 2,
          }}
        >
          {alert.detail}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 6,
          }}
        >
          <span style={{ fontSize: 11, color: '#aeaeb2' }}>{age}</span>
          {alert.actionable && onAction ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAction(alert);
              }}
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: '#007aff',
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 2,
              }}
            >
              {alert.actionLabel ?? 'View'}
              <ChevronRight size={12} strokeWidth={2.5} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Dismiss X */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(alert.id);
        }}
        aria-label="Dismiss"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 12,
          border: 'none',
          background: 'transparent',
          color: '#c7c7cc',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
        }}
      >
        <X size={13} strokeWidth={2.5} />
      </button>
    </div>
  );
});

export const AlertTray = memo(function AlertTray({
  alerts,
  open,
  onClose,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onDismissAll,
  onAction,
  variant,
}: AlertTrayProps) {
  const trayRef = useRef<HTMLDivElement>(null);
  // Prevent hydration mismatch — alerts are client-only (sessionStorage)
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  // Close on outside click (desktop only)
  useEffect(() => {
    if (!open || variant !== 'desktop') return;
    const handler = (e: MouseEvent) => {
      if (trayRef.current && !trayRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the click that opened the tray from immediately closing it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [open, variant, onClose]);

  // ESC to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const hasAlerts = alerts.length > 0;

  if (variant === 'mobile') {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9999,
          background: 'rgba(0, 0, 0, 0.4)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 250ms ease',
        }}
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            maxHeight: '85vh',
            background: 'rgba(255, 255, 255, 0.97)',
            backdropFilter: 'blur(40px) saturate(1.8)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
            borderRadius: '20px 20px 0 0',
            transform: open ? 'translateY(0)' : 'translateY(100%)',
            transition: 'transform 350ms cubic-bezier(0.32, 0.72, 0, 1)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {/* Handle bar */}
          <div
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              background: 'rgba(0,0,0,0.15)',
              margin: '8px auto 0',
            }}
          />
          {renderHeader(alerts, onMarkAllRead, onDismissAll, onClose)}
          {renderBody(alerts, hasAlerts, onMarkRead, onDismiss, onAction)}
        </div>
      </div>
    );
  }

  // Desktop dropdown
  return (
    <div
      ref={trayRef}
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        right: 0,
        width: 360,
        maxHeight: 480,
        borderRadius: 14,
        background: 'rgba(255, 255, 255, 0.96)',
        backdropFilter: 'blur(40px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
        boxShadow:
          '0 20px 60px rgba(15, 23, 42, 0.18), 0 1px 3px rgba(15, 23, 42, 0.08)',
        opacity: open ? 1 : 0,
        transform: open ? 'translateY(0) scale(1)' : 'translateY(-8px) scale(0.97)',
        pointerEvents: open ? 'auto' : 'none',
        transition:
          'opacity 220ms cubic-bezier(0.32, 0.72, 0, 1), transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 200,
      }}
    >
      {renderHeader(alerts, onMarkAllRead, onDismissAll, onClose)}
      {renderBody(alerts, hasAlerts, onMarkRead, onDismiss, onAction)}
    </div>
  );
});

// ── Shared renderers ──

function renderHeader(
  alerts: Alert[],
  onMarkAllRead: () => void,
  onDismissAll: () => void,
  onClose: () => void,
) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 16px 10px',
        borderBottom: '1px solid rgba(15, 23, 42, 0.06)',
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>
        Alerts{alerts.length > 0 ? ` (${alerts.length})` : ''}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        {alerts.length > 0 ? (
          <>
            <button
              type="button"
              onClick={onMarkAllRead}
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: '#007aff',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 8px',
              }}
            >
              Read all
            </button>
            <button
              type="button"
              onClick={onDismissAll}
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: '#8e8e93',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 8px',
              }}
            >
              Clear
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 14,
            border: 'none',
            background: 'rgba(0,0,0,0.05)',
            color: '#8e8e93',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <X size={14} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function renderBody(
  alerts: Alert[],
  hasAlerts: boolean,
  onMarkRead: (id: string) => void,
  onDismiss: (id: string) => void,
  onAction?: (alert: Alert) => void,
) {
  if (!hasAlerts) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 20px',
          color: '#c7c7cc',
        }}
      >
        <BellOff size={32} strokeWidth={1.5} />
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: '#aeaeb2',
            marginTop: 12,
          }}
        >
          All clear
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        padding: '4px 4px',
      }}
    >
      {alerts.map((alert) => (
        <AlertCard
          key={alert.id}
          alert={alert}
          onMarkRead={onMarkRead}
          onDismiss={onDismiss}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

// ── Helpers ──

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
