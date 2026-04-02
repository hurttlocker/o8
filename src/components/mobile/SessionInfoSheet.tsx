'use client';

/**
 * SessionInfoSheet — slides down from top when user taps the model pill.
 *
 * Apple Design Pass:
 * 1. Date-grouped media gallery with section headers
 * 2. Pull-to-dismiss gesture via touch tracking
 * 3. Apple photo grid corners (outer rounded, inner sharp)
 * 4. Stats hierarchy — context % is hero, others secondary
 * 5. Accessibility — role=dialog, aria-modal, aria-label, reduced motion
 * 6. Spring curve + staggered backdrop fade
 * 7. Haptic feedback on open
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock,
  Copy,
  Download,
  Image as ImageIcon,
  MessageSquare,
  X,
  Zap,
} from 'lucide-react';
import type { MobileTranscriptMedia } from '@/lib/mobile/types';
import { mediaHref } from './utils';

// ── Types ──

interface SessionMedia {
  path: string;
  name: string;
  mimeType: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'tool';
}

interface DateGroup {
  label: string;
  items: SessionMedia[];
}

interface SessionInfoSheetProps {
  open: boolean;
  onClose: () => void;
  sessionKey?: string;
  modelName?: string;
  status?: string;
  contextPercent?: number;
  totalTokens?: number;
  contextTokens?: number;
  messageCount?: number;
  sessionAge?: string;
  onCopyKey?: () => void;
  onExpandMedia?: (media: MobileTranscriptMedia) => void;
}

// ── Media Gallery Hook ──

function useSessionMedia(sessionKey?: string, open?: boolean) {
  const [media, setMedia] = useState<SessionMedia[]>([]);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<Record<string, SessionMedia[]>>({});

  useEffect(() => {
    if (!open || !sessionKey) return;
    if (cacheRef.current[sessionKey]) {
      setMedia(cacheRef.current[sessionKey]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/mobile/session-media?sessionKey=${encodeURIComponent(sessionKey)}`)
      .then(res => res.ok ? res.json() : { media: [] })
      .then(data => {
        if (cancelled) return;
        const items = data.media ?? [];
        cacheRef.current[sessionKey] = items;
        setMedia(items);
      })
      .catch(() => { if (!cancelled) setMedia([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionKey, open]);

  return { media, loading };
}

// ── Date grouping ──

function groupByDate(items: SessionMedia[]): DateGroup[] {
  const groups = new Map<string, SessionMedia[]>();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const item of items) {
    const d = new Date(item.timestamp);
    let label: string;
    if (d.toDateString() === today.toDateString()) {
      label = 'Today';
    } else if (d.toDateString() === yesterday.toDateString()) {
      label = 'Yesterday';
    } else {
      label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    }
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }

  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

// ── Grid corner radius helper (Apple Photos pattern) ──

function gridCornerRadius(index: number, total: number, cols: number): string {
  const R = 12;
  const row = Math.floor(index / cols);
  const col = index % cols;
  const totalRows = Math.ceil(total / cols);
  const isTop = row === 0;
  const isBottom = row === totalRows - 1;
  const isLeft = col === 0;
  const isRight = col === cols - 1 || index === total - 1;

  const tl = isTop && isLeft ? R : 0;
  const tr = isTop && isRight ? R : 0;
  const br = isBottom && isRight ? R : 0;
  const bl = isBottom && isLeft ? R : 0;
  return `${tl}px ${tr}px ${br}px ${bl}px`;
}

// ── Context Pressure Bar ──

function ContextBar({ percent }: { percent: number }) {
  const color = percent >= 85 ? '#ff3b30' : percent >= 70 ? '#ff9f0a' : percent >= 50 ? '#ffcc00' : '#34c759';
  return (
    <div style={{
      width: '100%',
      height: 4,
      borderRadius: 2,
      background: 'rgba(120, 120, 128, 0.12)',
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${Math.min(100, percent)}%`,
        height: '100%',
        borderRadius: 2,
        background: color,
        transition: 'width 400ms cubic-bezier(0.32, 0.72, 0, 1), background 400ms ease',
      }} />
    </div>
  );
}

// ── Formatters ──

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function contextLabel(percent: number): string {
  if (percent >= 85) return 'Critical';
  if (percent >= 70) return 'Elevated';
  if (percent >= 50) return 'Moderate';
  return 'Healthy';
}

function contextColor(percent: number): string {
  if (percent >= 85) return '#ff3b30';
  if (percent >= 70) return '#ff9f0a';
  if (percent >= 50) return '#ffcc00';
  return '#34c759';
}

// ── Pull-to-dismiss hook ──

function usePullToDismiss(sheetRef: React.RefObject<HTMLDivElement | null>, onClose: () => void, open: boolean) {
  const startYRef = useRef(0);
  const currentYRef = useRef(0);
  const isDragging = useRef(false);

  useEffect(() => {
    const el = sheetRef.current;
    if (!el || !open) return;

    function onTouchStart(e: TouchEvent) {
      // Only start drag if scrolled to top
      if (el!.scrollTop > 0) return;
      startYRef.current = e.touches[0].clientY;
      currentYRef.current = 0;
      isDragging.current = true;
    }

    function onTouchMove(e: TouchEvent) {
      if (!isDragging.current) return;
      const delta = e.touches[0].clientY - startYRef.current;
      // Only allow downward drag (positive delta = pulling down from top)
      if (delta < 0) {
        currentYRef.current = 0;
        el!.style.transform = '';
        return;
      }
      currentYRef.current = delta;
      // Rubber-band effect: diminishing returns past 100px
      const dampened = delta > 100 ? 100 + (delta - 100) * 0.3 : delta;
      el!.style.transform = `translateY(${dampened}px)`;
      el!.style.transition = 'none';
      // Prevent scroll while dragging
      if (delta > 10) e.preventDefault();
    }

    function onTouchEnd() {
      if (!isDragging.current) return;
      isDragging.current = false;
      el!.style.transition = '';
      if (currentYRef.current > 120) {
        // Dismiss: slide fully off screen
        el!.style.transform = 'translateY(100vh)';
        setTimeout(onClose, 200);
      } else {
        // Snap back
        el!.style.transform = '';
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [sheetRef, onClose, open]);
}

// ── Main Component ──

export const SessionInfoSheet = memo(function SessionInfoSheet({
  open,
  onClose,
  sessionKey,
  modelName,
  status,
  contextPercent = 0,
  totalTokens = 0,
  contextTokens = 0,
  messageCount = 0,
  sessionAge,
  onCopyKey,
  onExpandMedia,
}: SessionInfoSheetProps) {
  const { media, loading } = useSessionMedia(sessionKey, open);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Pull-to-dismiss
  usePullToDismiss(sheetRef, onClose, open);

  // Haptic feedback on open
  useEffect(() => {
    if (open) {
      try { navigator?.vibrate?.(10); } catch { /* no vibrate support */ }
    }
  }, [open]);

  // Close on backdrop tap
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Date-grouped media
  const dateGroups = useMemo(() => groupByDate(media), [media]);

  // Reduced motion check
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const springCurve = 'cubic-bezier(0.32, 0.72, 0, 1)';
  const sheetTransition = prefersReducedMotion ? 'none' : `transform 400ms ${springCurve}`;
  const backdropTransition = prefersReducedMotion ? 'none' : 'opacity 300ms ease';

  return (
    <div
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Session information"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        background: 'rgba(0, 0, 0, 0.35)',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        transition: backdropTransition,
        transitionDelay: open && !prefersReducedMotion ? '80ms' : '0ms',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <div
        ref={sheetRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          maxHeight: '85vh',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          background: 'rgba(255, 255, 255, 0.97)',
          backdropFilter: 'blur(40px) saturate(1.8)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
          borderRadius: '0 0 20px 20px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.15)',
          transform: open ? 'translateY(0)' : 'translateY(-100%)',
          transition: sheetTransition,
          paddingBottom: 'env(safe-area-inset-bottom, 20px)',
        }}
      >
        {/* Drag handle — functional for pull-to-dismiss */}
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          paddingTop: 'env(safe-area-inset-top, 48px)',
          paddingBottom: 8,
        }}>
          <div style={{
            width: 36,
            height: 5,
            borderRadius: 2.5,
            background: 'rgba(120, 120, 128, 0.3)',
            marginTop: 8,
          }} />
        </div>

        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 20px 16px',
        }}>
          <span style={{
            fontSize: 17,
            fontWeight: 600,
            color: '#111827',
            letterSpacing: '-0.02em',
          }}>Session Info</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close session info"
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              background: 'rgba(120, 120, 128, 0.12)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              minWidth: 44,
              minHeight: 44,
            }}
          >
            <X size={16} strokeWidth={2.5} style={{ color: '#A09890' }} />
          </button>
        </div>

        {/* Hero Context Card — #4 Stats hierarchy */}
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{
            background: 'rgba(120, 120, 128, 0.06)',
            borderRadius: 14,
            padding: 16,
          }}>
            {/* Context % hero */}
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              marginBottom: 8,
            }}>
              <span style={{
                fontSize: 34,
                fontWeight: 700,
                color: '#111827',
                letterSpacing: '-0.03em',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
              }}>{contextPercent.toFixed(0)}%</span>
              <span style={{
                fontSize: 13,
                fontWeight: 500,
                color: contextColor(contextPercent),
              }}>{contextLabel(contextPercent)}</span>
            </div>

            <ContextBar percent={contextPercent} />

            {/* Secondary stats line */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginTop: 10,
              color: '#A09890',
              fontSize: 12,
            }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Zap size={12} strokeWidth={2} />
                <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 11 }}>
                  {modelName ?? 'unknown'}
                </span>
              </span>
              {status ? (
                <span style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: status === 'running' ? '#34c759' : '#A09890',
                  background: status === 'running' ? 'rgba(52, 199, 89, 0.1)' : 'rgba(120, 120, 128, 0.08)',
                  padding: '2px 8px',
                  borderRadius: 6,
                }}>{status}</span>
              ) : null}
            </div>

            {/* Token + message + age line */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginTop: 8,
              color: '#aeaeb2',
              fontSize: 11,
            }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <MessageSquare size={10} strokeWidth={2} />
                {messageCount} msgs
              </span>
              {sessionAge ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Clock size={10} strokeWidth={2} />
                  {sessionAge}
                </span>
              ) : null}
              {totalTokens > 0 ? (
                <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  {formatTokens(totalTokens)} / {formatTokens(contextTokens)}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* Media Gallery — #1 Date-grouped, #3 Apple photo grid corners */}
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <span style={{
              fontSize: 15,
              fontWeight: 600,
              color: '#111827',
              letterSpacing: '-0.01em',
            }}>
              Media{media.length > 0 ? ` (${media.length})` : ''}
            </span>
          </div>

          {loading ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 2,
              borderRadius: 12,
              overflow: 'hidden',
            }}>
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} style={{
                  aspectRatio: '1',
                  background: 'rgba(120, 120, 128, 0.08)',
                  animation: 'shimmer 1.5s infinite ease-in-out',
                }} />
              ))}
            </div>
          ) : media.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: '28px 0',
              color: '#c7c7cc',
              fontSize: 13,
            }}>
              <ImageIcon size={28} strokeWidth={1.2} style={{ color: '#d1d1d6', marginBottom: 8 }} />
              <div style={{ fontWeight: 500 }}>No images yet</div>
            </div>
          ) : (
            dateGroups.map((group) => (
              <div key={group.label} style={{ marginBottom: 16 }}>
                {/* Date section header */}
                <div style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: '#A09890',
                  marginBottom: 6,
                  letterSpacing: '-0.01em',
                }}>
                  {group.label}
                </div>

                {/* Photo grid */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 2,
                }}>
                  {group.items.map((item, i) => (
                    <button
                      key={`${item.path}:${i}`}
                      type="button"
                      aria-label={`Photo from ${group.label}`}
                      onClick={() => {
                        if (onExpandMedia) {
                          onExpandMedia({
                            kind: 'image',
                            path: item.path,
                            name: item.name,
                            mimeType: item.mimeType,
                          });
                        }
                      }}
                      style={{
                        aspectRatio: '1',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        background: 'rgba(120, 120, 128, 0.08)',
                        overflow: 'hidden',
                        borderRadius: gridCornerRadius(i, group.items.length, 3),
                        WebkitTapHighlightColor: 'transparent',
                        minHeight: 44,
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={mediaHref(item.path)}
                        alt={item.name}
                        loading="lazy"
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                        }}
                      />
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Quick Actions */}
        <div style={{
          display: 'flex',
          gap: 10,
          padding: '0 20px 24px',
        }}>
          {onCopyKey ? (
            <ActionButton
              icon={<Copy size={14} strokeWidth={2} />}
              label="Copy Session ID"
              onClick={() => { onCopyKey(); onClose(); }}
            />
          ) : null}
          <ActionButton
            icon={<Download size={14} strokeWidth={2} />}
            label="Export"
            onClick={() => { onClose(); }}
          />
        </div>
      </div>
    </div>
  );
});

// ── Sub-components ──

function ActionButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '12px 0',
        borderRadius: 12,
        border: 'none',
        background: 'rgba(0, 122, 255, 0.08)',
        color: '#007aff',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        minHeight: 44,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
