'use client';
/* eslint-disable react-hooks/set-state-in-effect -- preserved from legacy Canvas.tsx extraction */

import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { LIGHT_CANVAS_VARS } from '@/components/desktop/canvas-utils';
import { measureHeight } from '@/lib/pretext';

interface TranscriptMessage {
  role: string;
  content: string | object;
}

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';

function canvasEmptyRepoLabel(selectedRepo?: string | null) {
  if (!selectedRepo) return null;
  return selectedRepo.split('/').pop() ?? selectedRepo;
}

function redactSecrets(raw: string): string {
  return raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret|password|token)\b(\s*[:=]\s*)([^\s"'`]+)/gi, '$1[redacted]')
    .replace(/\b(?:ghp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{12,})\b/g, '[redacted]');
}

function getMessageText(msg: TranscriptMessage): string {
  const raw = typeof msg.content === 'string'
    ? msg.content.slice(0, 2000)
    : JSON.stringify(msg.content).slice(0, 2000);
  return redactSecrets(raw);
}

const TX_PADDING_V = 12;
const TX_PADDING_H = 0;
const TX_ROLE_HEIGHT = 18;
const TX_GAP = 4;
const TX_MARGIN_BOTTOM = 8;
const TX_CONTAINER_PAD_H = 16;

export const TranscriptViewer = memo(function TranscriptViewer({ sessionKey }: { sessionKey: string }) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=500`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && Array.isArray(data)) {
          setMessages(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rect = entry.contentRect;
        setViewportHeight(rect.height);
        setContainerWidth(rect.width);
      }
    });
    ro.observe(el);
    setViewportHeight(el.clientHeight);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const contentWidth = containerWidth - TX_CONTAINER_PAD_H * 2 - TX_PADDING_H * 2;
  const messageHeights = useMemo(() => {
    if (contentWidth <= 0) return [];
    return messages.map((msg) => {
      const text = getMessageText(msg);
      const textH = measureHeight(text, 'small', contentWidth, 1.55, 'pre-wrap');
      return TX_PADDING_V * 2 + TX_ROLE_HEIGHT + TX_GAP + textH + TX_MARGIN_BOTTOM;
    });
  }, [messages, contentWidth]);

  const offsets = useMemo(() => {
    const arr = new Float64Array(messageHeights.length + 1);
    for (let i = 0; i < messageHeights.length; i++) {
      arr[i + 1] = arr[i] + messageHeights[i];
    }
    return arr;
  }, [messageHeights]);

  const totalHeight = offsets.length > 0 ? offsets[offsets.length - 1] : 0;

  const findStartIndex = useCallback((top: number): number => {
    let lo = 0;
    let hi = offsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid + 1] <= top) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }, [offsets]);

  const buffer = 5;
  const startIdx = Math.max(0, findStartIndex(scrollTop) - buffer);
  const endIdx = useMemo(() => {
    const bottomEdge = scrollTop + viewportHeight;
    let idx = startIdx;
    while (idx < messages.length && offsets[idx] < bottomEdge + 200) idx++;
    return Math.min(idx + buffer, messages.length);
  }, [messages.length, offsets, scrollTop, startIdx, viewportHeight]);

  const offsetY = offsets[startIdx] || 0;
  const visibleMessages = messages.slice(startIdx, endIdx);

  useEffect(() => {
    if (!loading && containerRef.current && messages.length > 0) {
      containerRef.current.scrollTop = totalHeight;
    }
  }, [loading, messages.length, totalHeight]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let rafId = 0;
    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(rafId);
    };
  }, []);

  if (loading) {
    return (
      <div style={{ paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32, color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading transcript...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        overflowY: 'auto',
        height: '100%',
        background: '#ffffff',
        ...LIGHT_CANVAS_VARS,
      } as React.CSSProperties}
    >
      {messages.length === 0 ? (
        <div
          style={{
            color: 'var(--t-text-muted)',
            fontSize: 13,
            paddingTop: 16,
            paddingRight: 24,
            paddingBottom: 16,
            paddingLeft: 24,
            marginTop: 16,
            marginRight: 24,
            marginBottom: 16,
            marginLeft: 24,
          }}
        >
          No messages in this session.
        </div>
      ) : (
        <div
          style={{
            height: totalHeight,
            position: 'relative',
            paddingTop: 16,
            paddingRight: TX_CONTAINER_PAD_H,
            paddingBottom: 0,
            paddingLeft: TX_CONTAINER_PAD_H,
          }}
        >
          <div style={{ position: 'absolute', top: 16 + offsetY, left: TX_CONTAINER_PAD_H, right: TX_CONTAINER_PAD_H }}>
            {visibleMessages.map((msg, i) => {
              const globalIdx = startIdx + i;
              const isUser = msg.role === 'user';
              return (
                <div
                  key={globalIdx}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: isUser ? 'flex-end' : 'flex-start',
                    marginBottom: TX_MARGIN_BOTTOM,
                    paddingTop: TX_PADDING_V,
                    paddingRight: 16,
                    paddingBottom: TX_PADDING_V,
                    paddingLeft: 16,
                    fontSize: 14,
                    lineHeight: 1.6,
                    fontFamily: '-apple-system, system-ui, sans-serif',
                    height: messageHeights[globalIdx] - TX_MARGIN_BOTTOM,
                    boxSizing: 'border-box',
                  }}
                >
                  <div
                    style={{
                      maxWidth: isUser ? '75%' : '90%',
                      color: isUser ? '#6b7280' : '#111827',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {getMessageText(msg)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

function PortPreviewBase({ url, port, repo }: { url: string; port: number; repo?: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const normalizedUrl = url.replace('0.0.0.0', 'localhost');
  const proxiedSrc = `/api/panel/proxy?url=${encodeURIComponent(normalizedUrl)}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 32,
          paddingTop: 0,
          paddingRight: 8,
          paddingBottom: 0,
          paddingLeft: 12,
          background: '#f1f5f9',
          borderBottom: '1px solid #e2e8f0',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#22c55e',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: '#64748b',
            fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {normalizedUrl}
        </span>
        {repo ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              color: '#94a3b8',
              paddingTop: 1,
              paddingRight: 5,
              paddingBottom: 1,
              paddingLeft: 5,
              borderRadius: 4,
              background: 'rgba(148,163,184,0.1)',
            }}
          >
            {repo}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            const iframe = iframeRef.current;
            if (iframe) {
              const src = iframe.src;
              iframe.src = '';
              setTimeout(() => {
                iframe.src = src;
              }, 50);
            }
            setRefreshKey((k) => k + 1);
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 6,
            border: '1px solid rgba(148,163,184,0.18)',
            background: 'rgba(255,255,255,0.82)',
            color: '#475569',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          title="Refresh preview"
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => window.open(normalizedUrl, '_blank')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 6,
            border: '1px solid rgba(148,163,184,0.18)',
            background: 'rgba(255,255,255,0.82)',
            color: '#475569',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          title="Open in browser"
        >
          <ExternalLink size={12} strokeWidth={2} />
        </button>
      </div>
      <iframe
        key={refreshKey}
        ref={iframeRef}
        src={proxiedSrc}
        title={`Preview localhost:${port}`}
        style={{
          flex: 1,
          border: 'none',
          width: '100%',
          background: '#ffffff',
        }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}

export const PortPreview = memo(PortPreviewBase);

function CanvasEmptyBase({
  selectedRepo,
  mode = 'idle',
}: {
  selectedRepo?: string | null;
  mode?: 'idle' | 'welcome';
}) {
  const repoLabel = canvasEmptyRepoLabel(selectedRepo);
  const title = mode === 'welcome' ? 'Canvas ready' : 'Content will appear here';
  const subtitle = repoLabel
    ? `Click an issue, file, or transcript from ${repoLabel} and the inspector will open here.`
    : 'Click an issue, file, or transcript and the inspector will open here.';

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        minHeight: 280,
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        position: 'relative',
        overflow: 'hidden',
        background: 'linear-gradient(180deg, var(--t-bg-subtle) 0%, var(--t-bg) 100%)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: -60,
          pointerEvents: 'none',
          background: 'radial-gradient(circle at 16% 18%, var(--t-accent-soft, rgba(37, 99, 235, 0.08)) 0%, transparent 34%), radial-gradient(circle at 82% 22%, rgba(148, 163, 184, 0.16) 0%, transparent 30%), radial-gradient(circle at 50% 92%, rgba(37, 99, 235, 0.06) 0%, transparent 34%)',
          opacity: 0.9,
        }}
      />

      <motion.div
        layout
        style={{
          position: 'relative',
          maxWidth: 840,
          width: '100%',
          marginTop: 0,
          marginRight: 'auto',
          marginBottom: 0,
          marginLeft: 'auto',
          borderRadius: 14,
          border: '1px solid var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(22px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(22px) saturate(1.5)',
          boxShadow: 'var(--t-panel-shadow)',
          overflow: 'hidden',
        }}
        initial={{ opacity: 0, y: 10, scale: 0.994 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.994 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      >
        <div
          style={{
            paddingTop: 20,
            paddingRight: 20,
            paddingBottom: 20,
            paddingLeft: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingTop: 4,
                  paddingRight: 10,
                  paddingBottom: 4,
                  paddingLeft: 10,
                  borderRadius: 10,
                  border: '1px solid var(--t-divider-subtle)',
                  background: 'var(--t-divider-subtle)',
                  color: 'var(--t-text-muted)',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: THEME_ACCENT,
                    opacity: 0.8,
                    flexShrink: 0,
                  }}
                />
                Canvas
              </div>
              <div
                style={{
                  marginTop: 12,
                  fontSize: 22,
                  lineHeight: 1.12,
                  fontWeight: 650,
                  letterSpacing: '-0.02em',
                  color: 'var(--t-text)',
                  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                }}
              >
                {title}
              </div>
              <div
                style={{
                  marginTop: 8,
                  maxWidth: 620,
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: 'var(--t-text-muted)',
                  letterSpacing: '-0.01em',
                  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                }}
              >
                {subtitle}
              </div>
            </div>

            {repoLabel ? (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  minHeight: 28,
                  paddingTop: 0,
                  paddingRight: 10,
                  paddingBottom: 0,
                  paddingLeft: 10,
                  borderRadius: 10,
                  border: '1px solid var(--t-divider-subtle)',
                  background: 'rgba(255, 255, 255, 0.46)',
                  color: 'var(--t-text-secondary)',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  flexShrink: 0,
                }}
              >
                {repoLabel}
              </div>
            ) : null}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
            }}
          >
            {[
              {
                label: 'Issue',
                accent: THEME_ACCENT,
                badge: 'Issue #128',
                lines: [72, 88, 63],
                footer: 'Status · review pending',
              },
              {
                label: 'File',
                accent: 'var(--t-text-secondary)',
                badge: 'src/app/dashboard/page.tsx',
                lines: [92, 84, 68, 76, 54],
                footer: 'File preview · ready',
              },
              {
                label: 'Transcript',
                accent: 'var(--t-text-secondary)',
                badge: 'Session replay',
                lines: [86, 74, 92, 60],
                footer: 'Transcript · live context',
              },
            ].map((card, index) => (
              <motion.div
                key={card.label}
                style={{
                  borderRadius: 14,
                  border: '1px solid var(--t-divider-subtle)',
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.38) 100%)',
                  paddingTop: 14,
                  paddingRight: 14,
                  paddingBottom: 14,
                  paddingLeft: 14,
                  minHeight: 160,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  opacity: 0.92,
                }}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30, delay: index * 0.05 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      minHeight: 24,
                      paddingTop: 0,
                      paddingRight: 10,
                      paddingBottom: 0,
                      paddingLeft: 10,
                      borderRadius: 10,
                      border: '1px solid var(--t-divider-subtle)',
                      background: THEME_ACCENT_SOFT,
                      color: card.accent,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                    }}
                  >
                    {card.label}
                  </div>
                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 999,
                      border: '1px solid var(--t-divider-subtle)',
                      background: 'rgba(255,255,255,0.55)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--t-text-faint)',
                    }}
                  >
                    <svg width={8} height={8} viewBox="0 0 8 8" fill="currentColor" style={{ display: 'block' }}>
                      <circle cx="4" cy="4" r="4" />
                    </svg>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: 'var(--t-text-secondary)',
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: '-0.01em',
                      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                    }}
                  >
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 3,
                        background: 'var(--t-divider-subtle)',
                        border: '1px solid var(--t-divider)',
                      }}
                    />
                    {card.badge}
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      paddingTop: 12,
                      paddingRight: 12,
                      paddingBottom: 12,
                      paddingLeft: 12,
                      borderRadius: 12,
                      border: '1px solid var(--t-divider-subtle)',
                      background: 'rgba(255,255,255,0.5)',
                    }}
                  >
                    {card.lines.map((width, lineIndex) => (
                      <div
                        key={`${card.label}-${lineIndex}`}
                        style={{
                          height: lineIndex === 0 ? 12 : 10,
                          width: `${width}%`,
                          borderRadius: 999,
                          background: lineIndex === 0
                            ? 'linear-gradient(90deg, var(--t-divider-subtle) 0%, rgba(37, 99, 235, 0.14) 100%)'
                            : 'var(--t-divider-subtle)',
                          opacity: lineIndex === 0 ? 0.88 : 0.7,
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div
                  style={{
                    marginTop: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 11,
                    lineHeight: 1.4,
                    color: 'var(--t-text-faint)',
                    letterSpacing: '-0.01em',
                    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
                  }}
                >
                  <span>{card.footer}</span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      paddingTop: 2,
                      paddingRight: 8,
                      paddingBottom: 2,
                      paddingLeft: 8,
                      borderRadius: 10,
                      border: '1px solid var(--t-divider-subtle)',
                      background: 'rgba(255,255,255,0.5)',
                    }}
                  >
                    preview
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export const CanvasEmpty = memo(CanvasEmptyBase);
