'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface RecentRelease {
  version: string;
  body: string;
  publishedAt: string | null;
  releaseUrl: string | null;
}

interface ReleaseSummary extends RecentRelease {
  summary: string;
}

interface WhatsNewCardProps {
  anchorRect: DOMRect;
  anchorElement: HTMLElement | null;
  onClose: () => void;
}

const CARD_WIDTH = 360;
const SUMMARY_CACHE_KEY = 'o8:account-whats-new:summaries:v1';

function readCachedSummary(version: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as Record<string, string>;
    return typeof cache[version] === 'string' ? cache[version] : null;
  } catch {
    return null;
  }
}

function writeCachedSummary(version: string, summary: string) {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(SUMMARY_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) as Record<string, string> : {};
    cache[version] = summary;
    window.localStorage.setItem(SUMMARY_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Release summaries are an optional convenience; storage can fail safely.
  }
}

function rawBodyFallback(release: RecentRelease): string {
  return release.body.slice(0, 300).trim() || 'Release notes are unavailable.';
}

async function summarizeRelease(release: RecentRelease, signal: AbortSignal): Promise<ReleaseSummary> {
  const cached = readCachedSummary(release.version);
  if (cached) return { ...release, summary: cached };

  try {
    const response = await fetch(
      `/api/panel/o8-update-summary?version=${encodeURIComponent(release.version)}`,
      { signal },
    );
    const payload = await response.json().catch(() => ({})) as { summary?: string };
    if (!response.ok || !payload.summary?.trim()) throw new Error('Summary unavailable.');
    const summary = payload.summary.trim();
    writeCachedSummary(release.version, summary);
    return { ...release, summary };
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    return { ...release, summary: rawBodyFallback(release) };
  }
}

export function WhatsNewCard({ anchorRect, anchorElement, onClose }: WhatsNewCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cardRef.current?.focus();
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || cardRef.current?.contains(target) || anchorElement?.contains(target)) return;
      onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [anchorElement, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/panel/releases/recent?count=2', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as {
          releases?: RecentRelease[];
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error || 'Unable to load releases.');
        const recent = (payload.releases ?? []).filter((release) => Boolean(release.version)).slice(0, 2);
        if (recent.length === 0) throw new Error('No recent releases found.');
        return Promise.all(recent.map((release) => summarizeRelease(release, controller.signal)));
      })
      .then((summaries) => {
        if (!controller.signal.aborted) setReleases(summaries);
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : 'Unable to load releases.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const left = typeof window === 'undefined'
    ? anchorRect.left + 8
    : Math.max(8, Math.min(anchorRect.left + 8, window.innerWidth - CARD_WIDTH - 8));
  const bottom = typeof window === 'undefined' ? 56 : window.innerHeight - anchorRect.top + 6;

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-modal="false"
      aria-label="What's new"
      tabIndex={-1}
      style={{
        position: 'fixed',
        left,
        bottom,
        width: CARD_WIDTH,
        maxHeight: Math.max(220, anchorRect.top - 18),
        overflowY: 'auto',
        paddingTop: 12,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider)',
        borderRadius: 10,
        background: 'var(--t-panel-solid)',
        boxShadow: 'var(--t-panel-shadow)',
        color: 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
        outline: 'none',
        zIndex: 1300,
      }}
    >
      <div
        style={{
          minHeight: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
          }}
        >
          {"What's new"}
        </span>
        <button
          type="button"
          aria-label="Close What's new"
          onClick={onClose}
          style={{
            width: 22,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            borderWidth: 0,
            borderRadius: 6,
            background: 'transparent',
            color: 'var(--t-text-muted)',
            cursor: 'pointer',
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = 'var(--t-panel-active)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {loading ? (
        <div
          style={{
            paddingTop: 16,
            paddingRight: 0,
            paddingBottom: 8,
            paddingLeft: 0,
            color: 'var(--t-text-muted)',
            fontSize: 12,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.5,
          }}
        >
          Reading release notes...
        </div>
      ) : error ? (
        <div
          style={{
            paddingTop: 16,
            paddingRight: 0,
            paddingBottom: 8,
            paddingLeft: 0,
            color: 'var(--t-text-muted)',
            fontSize: 12,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.5,
          }}
        >
          {error}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {releases.map((release, index) => (
            <section
              key={release.version}
              style={{
                paddingTop: 14,
                paddingRight: 0,
                paddingBottom: index === releases.length - 1 ? 2 : 14,
                paddingLeft: 0,
                borderBottomWidth: index === releases.length - 1 ? 0 : 1,
                borderBottomStyle: 'solid',
                borderBottomColor: 'var(--t-divider)',
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  letterSpacing: '-0.1px',
                  lineHeight: 1.25,
                  color: 'var(--t-text)',
                }}
              >
                {release.version}
              </div>
              <p
                style={{
                  marginTop: 8,
                  marginRight: 0,
                  marginBottom: 0,
                  marginLeft: 0,
                  color: 'var(--t-text-muted)',
                  fontSize: 12,
                  fontWeight: 400,
                  letterSpacing: '-0.1px',
                  lineHeight: 1.5,
                }}
              >
                {release.summary}
              </p>
            </section>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
