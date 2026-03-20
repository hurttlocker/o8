'use client';

import { useState, useEffect, useCallback, useRef, memo } from 'react';

export interface NotificationItem {
  id: string;
  type: 'approval' | 'alert' | 'agent_complete' | 'pr_ready' | 'build_failed' | 'stall' | 'info';
  title: string;
  body: string;
  timestamp: number;
  sessionKey?: string;
  dismissed?: boolean;
}

interface NotificationBannerProps {
  notifications: NotificationItem[];
  onDismiss: (id: string) => void;
  onTap: (notification: NotificationItem) => void;
}

const ICON_PATHS: Record<NotificationItem['type'], { path: string; color: string }> = {
  approval: { path: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', color: '#ff9500' },
  alert: { path: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01', color: '#ff3b30' },
  agent_complete: { path: 'M22 11.08V12a10 10 0 1 1-5.93-9.14 M22 4L12 14.01l-3-3', color: '#34c759' },
  pr_ready: { path: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3', color: '#af52de' },
  build_failed: { path: 'M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', color: '#ff3b30' },
  stall: { path: 'M12 2v10l4 4 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', color: '#ff9f0a' },
  info: { path: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01', color: '#007aff' },
};

function BannerCard({ notification, onDismiss, onTap }: {
  notification: NotificationItem;
  onDismiss: () => void;
  onTap: () => void;
}) {
  const icon = ICON_PATHS[notification.type] || ICON_PATHS.info;
  const startX = useRef(0);
  const startY = useRef(0);
  const deltaX = useRef(0);
  const deltaY = useRef(0);
  const axis = useRef<'none' | 'x' | 'y'>('none');
  const cardRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={cardRef}
      onClick={onTap}
      onTouchStart={(e) => {
        startX.current = e.touches[0].clientX;
        startY.current = e.touches[0].clientY;
        deltaX.current = 0;
        deltaY.current = 0;
        axis.current = 'none';
        // Prevent scroll underneath
        e.stopPropagation();
      }}
      onTouchMove={(e) => {
        deltaX.current = e.touches[0].clientX - startX.current;
        deltaY.current = e.touches[0].clientY - startY.current;
        // Lock axis on first significant movement
        if (axis.current === 'none' && (Math.abs(deltaX.current) > 5 || Math.abs(deltaY.current) > 5)) {
          axis.current = Math.abs(deltaY.current) > Math.abs(deltaX.current) ? 'y' : 'x';
        }
        if (!cardRef.current) return;
        if (axis.current === 'y' && deltaY.current < 0) {
          // Swipe up — translate up with resistance
          e.preventDefault();
          cardRef.current.style.transform = `translateY(${deltaY.current}px)`;
          cardRef.current.style.opacity = `${Math.max(0, 1 - Math.abs(deltaY.current) / 120)}`;
        } else if (axis.current === 'x') {
          // Swipe left/right
          e.preventDefault();
          cardRef.current.style.transform = `translateX(${deltaX.current}px)`;
          cardRef.current.style.opacity = `${Math.max(0, 1 - Math.abs(deltaX.current) / 150)}`;
        }
      }}
      onTouchEnd={() => {
        const dismissed =
          (axis.current === 'y' && deltaY.current < -40) ||
          (axis.current === 'x' && Math.abs(deltaX.current) > 60);
        if (dismissed) {
          // Animate out before removing
          if (cardRef.current) {
            cardRef.current.style.transition = 'transform 200ms ease, opacity 200ms ease';
            if (axis.current === 'y') {
              cardRef.current.style.transform = 'translateY(-80px)';
            } else {
              cardRef.current.style.transform = `translateX(${deltaX.current > 0 ? 200 : -200}px)`;
            }
            cardRef.current.style.opacity = '0';
          }
          setTimeout(onDismiss, 180);
        } else if (cardRef.current) {
          cardRef.current.style.transition = 'transform 250ms cubic-bezier(0.32, 0.72, 0, 1), opacity 250ms ease';
          cardRef.current.style.transform = 'translate(0, 0)';
          cardRef.current.style.opacity = '1';
          // Clear transition after spring-back
          setTimeout(() => {
            if (cardRef.current) cardRef.current.style.transition = '';
          }, 260);
        }
        deltaX.current = 0;
        deltaY.current = 0;
        axis.current = 'none';
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: 10,
        background: 'rgba(0,122,255,0.05)',
        backdropFilter: 'blur(40px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
        border: '1px solid rgba(0,122,255,0.1)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.03)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        transition: 'transform 200ms ease, opacity 200ms ease',
        animation: 'bannerSlideDown 350ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {/* Icon — small colored dot */}
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: icon.color,
        flexShrink: 0,
      }} />

      {/* Content — single line */}
      <p style={{
        margin: 0, fontSize: 11, fontWeight: 600,
        color: '#3c3c43',
        fontFamily: '-apple-system, system-ui, sans-serif',
        flex: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {notification.title}
      </p>

      {/* Dismiss × */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        style={{
          width: 14, height: 14, borderRadius: '50%',
          background: 'rgba(0,0,0,0.04)',
          border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0, padding: 0,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <svg width="6" height="6" viewBox="0 0 24 24" fill="none"
          stroke="#8e8e93" strokeWidth="3" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export const NotificationBanner = memo(function NotificationBanner({
  notifications,
  onDismiss,
  onTap,
}: NotificationBannerProps) {
  const visible = notifications.filter(n => !n.dismissed).slice(0, 4);

  if (visible.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 'calc(env(safe-area-inset-top, 0px) + 80px)',
      left: 20, right: 20,
      zIndex: 9997,
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      pointerEvents: 'auto',
    }}>
      {visible.map((n) => (
        <BannerCard
          key={n.id}
          notification={n}
          onDismiss={() => onDismiss(n.id)}
          onTap={() => onTap(n)}
        />
      ))}

      <style>{`
        @keyframes bannerSlideDown {
          from { opacity: 0; transform: translateY(-20px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
});

// Hook to generate notifications from snapshot changes
export function useNotifications(snapshot: { items: Array<{ id: string; kind: string; title: string; detail: string; timestampLabel?: string; sessionKey?: string }>; sessions: Array<{ id: string; name: string; status: string; currentTask: string; sessionKey: string }> }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const seenIds = useRef(new Set<string>());
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      // First load — mark all existing items as seen
      for (const item of snapshot.items) seenIds.current.add(item.id);
      for (const s of snapshot.sessions) seenIds.current.add(s.id);
      initialized.current = true;
      return;
    }

    const newNotifs: NotificationItem[] = [];

    // New approval items
    for (const item of snapshot.items) {
      if (!seenIds.current.has(item.id)) {
        seenIds.current.add(item.id);
        newNotifs.push({
          id: item.id,
          type: item.kind === 'approval' ? 'approval' : 'alert',
          title: item.title,
          body: item.detail,
          timestamp: Date.now(),
          sessionKey: item.sessionKey,
        });
      }
    }

    // Agent completions
    for (const s of snapshot.sessions) {
      const key = `${s.id}-${s.status}`;
      if (!seenIds.current.has(key)) {
        seenIds.current.add(key);
        if (s.status === 'idle' && s.currentTask) {
          newNotifs.push({
            id: key,
            type: 'agent_complete',
            title: `${s.name} finished`,
            body: s.currentTask,
            timestamp: Date.now(),
            sessionKey: s.sessionKey,
          });
        }
      }
    }

    if (newNotifs.length > 0) {
      setNotifications(prev => [...newNotifs, ...prev].slice(0, 20));

      // Auto-dismiss after 2.5 seconds
      const ids = newNotifs.map(n => n.id);
      setTimeout(() => {
        setNotifications(prev =>
          prev.map(n => ids.includes(n.id) ? { ...n, dismissed: true } : n)
        );
      }, 2500);
    }
  }, [snapshot.items, snapshot.sessions]);

  const dismiss = useCallback((id: string) => {
    setNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, dismissed: true } : n)
    );
  }, []);

  const unreadCount = notifications.filter(n => !n.dismissed).length;

  return { notifications, dismiss, unreadCount };
}
