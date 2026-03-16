'use client';

/**
 * SessionInfoSheet — slides down from top when user taps the model pill.
 *
 * Shows: model + status, context pressure bar, session stats,
 * media gallery (all images from conversation including compacted),
 * quick actions.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
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

    // Use cache if available
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

// ── Context Pressure Bar ──

function ContextBar({ percent }: { percent: number }) {
  const color = percent >= 85 ? '#ff3b30' : percent >= 70 ? '#ff9f0a' : percent >= 50 ? '#ffcc00' : '#34c759';
  return (
    <div style={{
      width: '100%',
      height: 6,
      borderRadius: 3,
      background: 'rgba(120, 120, 128, 0.12)',
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${Math.min(100, percent)}%`,
        height: '100%',
        borderRadius: 3,
        background: color,
        transition: 'width 300ms ease, background 300ms ease',
      }} />
    </div>
  );
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

  // Close on backdrop tap
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  return (
    <div
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        background: 'rgba(0, 0, 0, 0.35)',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 250ms ease',
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
          maxHeight: '80vh',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          background: 'rgba(255, 255, 255, 0.97)',
          backdropFilter: 'blur(40px) saturate(1.8)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
          borderRadius: '0 0 20px 20px',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.15)',
          transform: open ? 'translateY(0)' : 'translateY(-100%)',
          transition: 'transform 350ms cubic-bezier(0.32, 0.72, 0, 1)',
          paddingBottom: 'env(safe-area-inset-bottom, 20px)',
        }}
      >
        {/* Safe area spacer for notch */}
        <div style={{ height: 'env(safe-area-inset-top, 48px)', minHeight: 48 }} />

        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 20px 12px',
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
            }}
          >
            <X size={16} strokeWidth={2.5} style={{ color: '#8e8e93' }} />
          </button>
        </div>

        {/* Model + Status Card */}
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{
            background: 'rgba(120, 120, 128, 0.06)',
            borderRadius: 14,
            padding: 16,
          }}>
            {/* Model name */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 12,
            }}>
              <Zap size={16} strokeWidth={2} style={{ color: '#007aff' }} />
              <span style={{
                fontSize: 15,
                fontWeight: 600,
                color: '#111827',
                letterSpacing: '-0.01em',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}>{modelName ?? 'unknown'}</span>
              {status ? (
                <span style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: status === 'running' ? '#34c759' : '#8e8e93',
                  background: status === 'running' ? 'rgba(52, 199, 89, 0.1)' : 'rgba(120, 120, 128, 0.08)',
                  padding: '2px 8px',
                  borderRadius: 6,
                }}>{status}</span>
              ) : null}
            </div>

            {/* Context bar */}
            <ContextBar percent={contextPercent} />
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 6,
            }}>
              <span style={{ fontSize: 11, color: '#8e8e93' }}>
                {contextPercent.toFixed(0)}% context used
              </span>
              <span style={{ fontSize: 11, color: '#8e8e93', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                {formatTokens(totalTokens)} / {formatTokens(contextTokens)}
              </span>
            </div>
          </div>
        </div>

        {/* Stats Row */}
        <div style={{
          display: 'flex',
          gap: 10,
          padding: '0 20px 16px',
        }}>
          <StatPill icon={<MessageSquare size={13} strokeWidth={2} />} value={String(messageCount)} label="messages" />
          <StatPill icon={<Clock size={13} strokeWidth={2} />} value={sessionAge ?? '—'} label="active" />
          <StatPill icon={<ImageIcon size={13} strokeWidth={2} />} value={String(media.length)} label="images" />
        </div>

        {/* Media Gallery */}
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <span style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#111827',
              letterSpacing: '-0.01em',
            }}>
              Media {media.length > 0 ? `(${media.length})` : ''}
            </span>
          </div>

          {loading ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 4,
            }}>
              {[0, 1, 2, 3, 4, 5].map(i => (
                <div key={i} style={{
                  aspectRatio: '1',
                  borderRadius: 8,
                  background: 'rgba(120, 120, 128, 0.08)',
                  animation: 'shimmer 1.5s infinite ease-in-out',
                }} />
              ))}
            </div>
          ) : media.length === 0 ? (
            <div style={{
              textAlign: 'center',
              padding: '24px 0',
              color: '#aeaeb2',
              fontSize: 13,
            }}>
              <ImageIcon size={24} strokeWidth={1.5} style={{ color: '#d1d5db', marginBottom: 8 }} />
              <div>No images in this conversation</div>
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 4,
              borderRadius: 12,
              overflow: 'hidden',
            }}>
              {media.map((item, i) => (
                <button
                  key={`${item.path}:${i}`}
                  type="button"
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
                    position: 'relative',
                    WebkitTapHighlightColor: 'transparent',
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
                  {/* Timestamp overlay on hover/first image */}
                  {i === 0 || i === media.length - 1 ? (
                    <span style={{
                      position: 'absolute',
                      bottom: 4,
                      left: 4,
                      fontSize: 9,
                      color: '#fff',
                      background: 'rgba(0,0,0,0.5)',
                      borderRadius: 4,
                      padding: '1px 5px',
                      fontWeight: 500,
                    }}>
                      {i === 0 ? 'Oldest' : 'Latest'}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div style={{
          display: 'flex',
          gap: 10,
          padding: '0 20px 20px',
        }}>
          {onCopyKey ? (
            <ActionButton
              icon={<Copy size={14} strokeWidth={2} />}
              label="Copy Key"
              onClick={() => { onCopyKey(); onClose(); }}
            />
          ) : null}
          <ActionButton
            icon={<Download size={14} strokeWidth={2} />}
            label="Export"
            onClick={() => {
              // Future: export transcript
              onClose();
            }}
          />
        </div>

        {/* Bottom handle */}
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          paddingBottom: 8,
        }}>
          <div style={{
            width: 36,
            height: 5,
            borderRadius: 2.5,
            background: 'rgba(120, 120, 128, 0.2)',
          }} />
        </div>
      </div>
    </div>
  );
});

// ── Sub-components ──

function StatPill({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 4,
      padding: '10px 0',
      borderRadius: 12,
      background: 'rgba(120, 120, 128, 0.06)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#007aff' }}>
        {icon}
        <span style={{
          fontSize: 15,
          fontWeight: 600,
          color: '#111827',
          fontFamily: '"SF Mono", ui-monospace, monospace',
          fontVariantNumeric: 'tabular-nums',
        }}>{value}</span>
      </div>
      <span style={{ fontSize: 10, color: '#8e8e93', fontWeight: 500 }}>{label}</span>
    </div>
  );
}

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
