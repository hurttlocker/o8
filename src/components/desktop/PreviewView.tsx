'use client';

/**
 * PreviewView -- Injection preview tab in the Memory view.
 *
 * The "moment of truth" surface: shows exactly what directives + ledger text
 * will be injected into the next agent session for a given repo.
 *
 * Fetches from /api/cortex/preview and renders two collapsible monospace blocks.
 */

import { useCallback, useEffect, useState } from 'react';
import { EyeIcon, RefreshIcon, ChevronRightIcon } from '@/components/desktop/directives-icons';

const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

interface PreviewBlock {
  text: string;
  tokenEstimate: number;
  count: number;
}

interface PreviewResponse {
  repoName: string;
  repoPath: string;
  directives: PreviewBlock;
  ledger: PreviewBlock;
  combined: string;
  totalTokens: number;
}

export function PreviewView({ active }: { active: boolean }): React.ReactElement {
  const [repoName, setRepoName] = useState('cortex-ide');
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirOpen, setDirOpen] = useState(true);
  const [ledOpen, setLedOpen] = useState(true);

  const fetchPreview = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (repoName.trim()) params.set('repoName', repoName.trim());
      const res = await fetch(`/api/cortex/preview?${params.toString()}`);
      if (!res.ok) { setError('Failed to load preview'); return; }
      const json = (await res.json()) as PreviewResponse;
      setData(json);
      setError(null);
    } catch (e) {
      console.error('[preview-view] fetch error:', e);
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [repoName]);

  useEffect(() => {
    if (active) { fetchPreview(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const hasContent = !!(data && (data.directives.text || data.ledger.text));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Scope selector */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        paddingTop: 10, paddingBottom: 10, paddingLeft: 16, paddingRight: 16,
        borderBottom: '1px solid var(--t-divider-subtle)',
        flexShrink: 0,
      }}>
        <span style={{
          fontSize: 11, color: 'var(--t-text-muted)',
          fontFamily: 'system-ui, sans-serif', letterSpacing: '-0.01em',
          flexShrink: 0,
        }}>
          Repo
        </span>
        <input
          type="text"
          value={repoName}
          onChange={(e) => setRepoName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') fetchPreview(); }}
          placeholder="cortex-ide"
          style={{
            flex: 1, minWidth: 0,
            paddingTop: 6, paddingBottom: 6, paddingLeft: 10, paddingRight: 10,
            borderRadius: 8,
            border: '1px solid var(--t-input-border)',
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            fontSize: 12, fontFamily: MONO_FONT,
            letterSpacing: '-0.01em',
            outline: 'none',
            minHeight: 30,
          }}
        />
        <button
          type="button"
          onClick={fetchPreview}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            paddingTop: 6, paddingBottom: 6, paddingLeft: 10, paddingRight: 10,
            borderRadius: 8,
            border: '1px solid var(--t-divider)',
            background: 'var(--t-btn-secondary-bg)',
            color: 'var(--t-text-muted)',
            fontSize: 11, fontFamily: 'system-ui, sans-serif',
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.6 : 1,
            minHeight: 30,
          }}
        >
          <RefreshIcon size={11} color="currentColor" />
          Refresh
        </button>
      </div>

      {/* Token total */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 10, paddingBottom: 10, paddingLeft: 16, paddingRight: 16,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontSize: 11, color: 'var(--t-text-muted)',
        fontFamily: MONO_FONT, letterSpacing: '-0.01em',
        flexShrink: 0,
      }}>
        <span>Total: {data?.totalTokens ?? 0} tokens</span>
        {data && (
          <span>
            directives {data.directives.count} · ledger {data.ledger.count}
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {loading && !data && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            paddingTop: 48, paddingBottom: 48,
            color: 'var(--t-text-muted)', fontSize: 13,
          }}>
            Loading preview...
          </div>
        )}

        {error && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            paddingTop: 48, paddingBottom: 48,
            color: 'var(--t-text-muted)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {!loading && !error && !hasContent && (
          <div style={{
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            paddingTop: 48, paddingBottom: 48, paddingLeft: 24, paddingRight: 24,
            color: 'var(--t-text-muted)', fontSize: 13, gap: 8,
            textAlign: 'center',
          }}>
            <EyeIcon size={24} color="var(--t-text-faint)" />
            <span>No context will be injected for this repo.</span>
            <span style={{ fontSize: 12, color: 'var(--t-text-faint)' }}>
              Create directives or dispatch sessions to see a preview.
            </span>
          </div>
        )}

        {data && hasContent && (
          <div style={{
            display: 'flex', flexDirection: 'column', gap: 10,
            paddingTop: 12, paddingBottom: 16, paddingLeft: 12, paddingRight: 12,
          }}>
            <PreviewSection
              title="Directives Block"
              tokens={data.directives.tokenEstimate}
              count={data.directives.count}
              text={data.directives.text}
              open={dirOpen}
              onToggle={() => setDirOpen((v) => !v)}
            />
            <PreviewSection
              title="Session Ledger Block"
              tokens={data.ledger.tokenEstimate}
              count={data.ledger.count}
              text={data.ledger.text}
              open={ledOpen}
              onToggle={() => setLedOpen((v) => !v)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewSection({
  title,
  tokens,
  count,
  text,
  open,
  onToggle,
}: {
  title: string;
  tokens: number;
  count: number;
  text: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      borderRadius: 14,
      border: '1px solid var(--t-divider)',
      background: 'var(--t-panel)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          minHeight: 40,
          textAlign: 'left',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 16, height: 16,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 120ms ease',
        }}>
          <ChevronRightIcon size={12} color="var(--t-text-muted)" />
        </div>
        <span style={{
          flex: 1,
          fontSize: 12, fontWeight: 600,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
          fontFamily: 'system-ui, sans-serif',
        }}>
          {title}
        </span>
        <span style={{
          fontSize: 10, color: 'var(--t-text-muted)',
          fontFamily: MONO_FONT, letterSpacing: '-0.01em',
        }}>
          {count} · {tokens}t
        </span>
      </button>

      {/* Body */}
      {open && (
        <pre style={{
          margin: 0,
          marginTop: 0,
          paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12,
          borderTop: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
          color: 'var(--t-text-secondary)',
          fontFamily: MONO_FONT,
          fontSize: 11,
          lineHeight: 1.55,
          letterSpacing: '-0.01em',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'auto',
          borderRadius: 8,
        }}>
          {text || '(empty)'}
        </pre>
      )}
    </div>
  );
}
