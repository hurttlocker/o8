'use client';

/**
 * AlertToast — desktop-only urgent alert toast.
 *
 * Slides in from bottom-left (near NavRail bell), auto-dismisses after 5s.
 * Only fires for urgent alerts (approval, error, context-critical).
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, ShieldCheck, X } from 'lucide-react';
import type { Alert } from '@/lib/alerts/types';

const TOAST_DURATION = 5_000;
const MAX_TOASTS = 3;

const ICON_MAP: Record<string, typeof AlertTriangle> = {
  approval: ShieldCheck,
  error: AlertTriangle,
  'context-critical': Gauge,
  completed: CheckCircle2,
};

interface ToastItem {
  alert: Alert;
  visible: boolean;
  exiting: boolean;
}

interface AlertToastProps {
  alerts: Alert[];
  onAction?: (alert: Alert) => void;
}

export const AlertToast = memo(function AlertToast({
  alerts,
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
        bottom: 16,
        left: 72,
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map(({ alert, exiting }) => {
        const Icon = ICON_MAP[alert.type] ?? AlertTriangle;

        return (
          <div
            key={alert.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 14px',
              borderRadius: 14,
              background: 'linear-gradient(180deg, rgba(239, 246, 255, 0.82), rgba(191, 219, 254, 0.52))',
              backdropFilter: 'blur(28px) saturate(1.7)',
              WebkitBackdropFilter: 'blur(28px) saturate(1.7)',
              border: '1px solid rgba(147, 197, 253, 0.22)',
              boxShadow:
                '0 22px 56px rgba(29, 78, 216, 0.18), 0 8px 24px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255,255,255,0.45)',
              width: 320,
              pointerEvents: 'auto',
              cursor: 'pointer',
              opacity: exiting ? 0 : 1,
              transform: exiting
                ? 'translateX(-120%) scale(0.95)'
                : 'translateX(0) scale(1)',
              transition:
                'opacity 300ms ease, transform 300ms cubic-bezier(0.32, 0.72, 0, 1)',
            }}
            onClick={() => {
              if (onAction) onAction(alert);
              dismissToast(alert.id);
            }}
          >
            <Icon size={18} strokeWidth={2} style={{ color: '#2563eb', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#0f172a',
                  lineHeight: 1.3,
                }}
              >
                {alert.title}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: '#475569',
                  lineHeight: 1.3,
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
                background: 'rgba(37, 99, 235, 0.08)',
                color: '#64748b',
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
