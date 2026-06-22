'use client';

/**
 * AlertToast — desktop-only urgent alert toast.
 *
 * Slides in from bottom-left (near NavRail bell), auto-dismisses after 5s.
 * Only fires for urgent alerts (approval, error, context-critical).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, ShieldCheck, X } from '@/components/desktop/lucide-shims';
import type { Alert } from '@/lib/alerts/types';

const TOAST_DURATION = 5_000;
const MAX_TOASTS = 3;

const ICON_MAP: Record<string, typeof AlertTriangle> = {
  approval: ShieldCheck,
  error: AlertTriangle,
  'context-critical': Gauge,
  completed: CheckCircle2,
};

// Per-severity accent (status colors, theme-stable) — replaces the old
// always-blue icon. The surface itself rides the theme tokens below.
const ACCENT_BY_TYPE: Record<string, string> = {
  approval: 'var(--t-accent, #2563eb)',
  error: '#ef4444',
  'context-critical': '#f59e0b',
  completed: '#22c55e',
};

interface ToastItem {
  alert: Alert;
  visible: boolean;
  exiting: boolean;
}

interface AlertToastProps {
  alerts: Alert[];
  compact?: boolean;
  onAction?: (alert: Alert) => void;
}

export const AlertToast = memo(function AlertToast({
  alerts,
  compact = false,
  onAction,
}: AlertToastProps) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const shownRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) =>
      prev.map((t) => (t.alert.id === id ? { ...t, exiting: true } : t)),
    );
    // Remove after animation
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.alert.id !== id));
    }, 300);
    // Clear timer
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  // Watch for new urgent alerts
  useEffect(() => {
    const urgent = alerts.filter(
      (a) => a.severity === 'urgent' && !a.read && !shownRef.current.has(a.id),
    );
    if (urgent.length === 0) return;

    for (const alert of urgent) {
      shownRef.current.add(alert.id);
    }

    setToasts((prev) => {
      const next = [
        ...urgent.map((a) => ({ alert: a, visible: true, exiting: false })),
        ...prev,
      ].slice(0, MAX_TOASTS);
      return next;
    });

    // Auto-dismiss timers
    for (const alert of urgent) {
      const timer = setTimeout(() => {
        dismissToast(alert.id);
      }, TOAST_DURATION);
      timersRef.current.set(alert.id, timer);
    }
  }, [alerts, dismissToast]);

  // Cleanup timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        // Nudged above the 28px DesktopStatusBar (16 base + 28 strip + 4 gap).
        bottom: compact ? 72 : 48,
        left: compact ? 16 : 72,
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map(({ alert, exiting }) => {
        const Icon = ICON_MAP[alert.type] ?? AlertTriangle;
        const accent = ACCENT_BY_TYPE[alert.type] ?? 'var(--t-accent, #2563eb)';

        return (
          <div
            key={alert.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: 14,
              paddingRight: 14,
              borderRadius: 14,
              // Theme glass surface (was a hardcoded baby-blue gradient that
              // ignored the palette + read as a light blob in dark mode).
              background: 'color-mix(in srgb, var(--t-bg-card) 92%, transparent)',
              backdropFilter: 'blur(24px) saturate(1.4)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
              border: '1px solid var(--t-panel-border, var(--t-border))',
              boxShadow: 'var(--t-shadow-card, 0 18px 45px rgba(15, 23, 42, 0.16))',
              width: 320,
              pointerEvents: 'auto',
              cursor: 'pointer',
              opacity: exiting ? 0 : 1,
              transform: exiting
                ? 'translateX(-120%) scale(0.95)'
                : 'translateX(0) scale(1)',
              transition:
                'opacity 300ms ease, transform 300ms cubic-bezier(0.32, 0.72, 0, 1)',
              fontFamily: 'var(--font-sans-system)',
            }}
            onClick={() => {
              if (onAction) onAction(alert);
              dismissToast(alert.id);
            }}
          >
            <Icon size={18} strokeWidth={2} style={{ color: accent, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  // Hurttlocker row title: 13.5/300/-0.1px (was 13/600).
                  fontSize: 13.5,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  color: 'var(--t-text)',
                  lineHeight: 1.3,
                }}
              >
                {alert.title}
              </div>
              <div
                style={{
                  // Hurttlocker meta: 9.5/260/-0.4 (was 12/normal).
                  fontSize: 9.5,
                  fontWeight: 260,
                  letterSpacing: '-0.4px',
                  color: 'var(--t-text-muted)',
                  lineHeight: 1.35,
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {alert.detail}
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                dismissToast(alert.id);
              }}
              aria-label="Dismiss"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                borderRadius: 11,
                border: 'none',
                background: 'var(--t-hover, rgba(120, 120, 128, 0.12))',
                color: 'var(--t-text-secondary)',
                cursor: 'pointer',
                padding: 0,
                flexShrink: 0,
              }}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          </div>
        );
      })}
    </div>
  );
});
