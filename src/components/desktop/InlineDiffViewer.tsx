'use client';

/**
 * InlineDiffViewer — desktop inline diff for awaiting_review packets (#659).
 *
 * Sits inside the Canvas tab area when `kind: 'diff'` arrives with packet
 * metadata in `tab.meta` (sessionKey / worktreePath / baseBranch / packetId).
 * Mirrors MobileDiffViewer's structure but on a desktop density:
 *   - sticky file-pill bar at the top, click to scroll
 *   - per-file sticky header
 *   - per-hunk collapsible block with +/- coloring + line numbers
 *   - per-hunk "accept this hunk" toggle (does NOT auto-merge — emits an
 *     inline patch via serializeSelectedHunks() that can be copied/applied)
 *   - bottom action strip: copy-patch + "Merge lane" CTA wired to the
 *     existing /api/orchestrator/merge approval+merge pipeline
 *
 * Read-only when `packetId` is absent (e.g. opened from the workspace diff
 * tab without packet context) — no merge button, but the viewer still works.
 *
 * Hunk + file rendering live in `./inline-diff/{HunkBlock,FileSection}.tsx`
 * to respect the 800-line ceiling.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  parseDiff,
  serializeSelectedHunks,
  hunkKey,
  type ParsedDiffFile,
} from '@/lib/diff/parse';
import { actionReceiptIsInProgress, correlatedActionIsUnsettled, fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import { Check, Copy, GitMerge, RefreshCw } from './lucide-shims';
import { FileSection, fileAnchorId, statusTone } from './inline-diff/FileSection';

export interface InlineDiffViewerProps {
  packetId?: string | null;
  sessionKey?: string | null;
  worktreePath?: string | null;
  baseBranch?: string | null;
  laneId?: string | null;
  /** Optional override label rendered in the header. */
  title?: string | null;
}

interface DiffPayload {
  rawDiff: string;
  additions: number;
  deletions: number;
  fileCount: number;
  worktreePath: string | null;
  baseBranch: string | null;
  error?: string | null;
}

interface MergeState {
  status: 'idle' | 'pending' | 'success' | 'error';
  message: string | null;
}

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function dirname(filePath: string): string {
  if (!filePath.includes('/')) return '';
  return filePath.slice(0, filePath.lastIndexOf('/'));
}

export const InlineDiffViewer = memo(function InlineDiffViewer({
  packetId,
  sessionKey,
  worktreePath,
  baseBranch,
  laneId,
  title,
}: InlineDiffViewerProps) {
  const [payload, setPayload] = useState<DiffPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [acceptance, setAcceptance] = useState<Record<string, boolean>>({});
  const [merge, setMerge] = useState<MergeState>({ status: 'idle', message: null });
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (sessionKey) params.set('sessionKey', sessionKey);
    if (worktreePath) params.set('worktreePath', worktreePath);
    if (baseBranch) params.set('baseBranch', baseBranch);
    return params.toString();
  }, [sessionKey, worktreePath, baseBranch]);

  const loadDiff = useCallback(
    async (signal?: AbortSignal) => {
      if (!queryString) {
        setPayload(null);
        setFetchError(
          'Missing sessionKey or worktreePath. Open this diff from an awaiting_review packet to load changes.',
        );
        return;
      }
      setLoading(true);
      setFetchError(null);
      try {
        const response = await fetch(`/api/worktrees/diff?${queryString}`, { cache: 'no-store', signal });
        if (!response.ok) {
          setPayload(null);
          setFetchError(`HTTP ${response.status} loading worktree diff`);
          return;
        }
        const data = (await response.json()) as {
          diff?: string;
          additions?: number;
          deletions?: number;
          fileCount?: number;
          worktreePath?: string | null;
          baseBranch?: string | null;
          error?: string | null;
        };
        setPayload({
          rawDiff: typeof data.diff === 'string' ? data.diff : '',
          additions: data.additions ?? 0,
          deletions: data.deletions ?? 0,
          fileCount: data.fileCount ?? 0,
          worktreePath: data.worktreePath ?? null,
          baseBranch: data.baseBranch ?? null,
          error: data.error ?? null,
        });
        if (data.error && !data.diff) setFetchError(data.error);
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return;
        setPayload(null);
        setFetchError(error instanceof Error ? error.message : 'Failed to load diff');
      } finally {
        setLoading(false);
      }
    },
    [queryString],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDiff(controller.signal);
    return () => controller.abort();
  }, [loadDiff]);

  const parsedFiles = useMemo<ParsedDiffFile[]>(
    () => (payload?.rawDiff ? parseDiff(payload.rawDiff) : []),
    [payload?.rawDiff],
  );

  // Default acceptance to true for every hunk we see, persisted across re-parses.
  useEffect(() => {
    setAcceptance((prev) => {
      const next: Record<string, boolean> = { ...prev };
      let changed = false;
      for (const file of parsedFiles) {
        for (let idx = 0; idx < file.hunks.length; idx += 1) {
          const key = hunkKey(file, idx);
          if (!(key in next)) {
            next[key] = true;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [parsedFiles]);

  const acceptedHunkCount = useMemo(() => {
    let count = 0;
    for (const file of parsedFiles) {
      for (let idx = 0; idx < file.hunks.length; idx += 1) {
        if (acceptance[hunkKey(file, idx)] !== false) count += 1;
      }
    }
    return count;
  }, [parsedFiles, acceptance]);

  const totalHunkCount = useMemo(
    () => parsedFiles.reduce((sum, file) => sum + file.hunks.length, 0),
    [parsedFiles],
  );

  const partialPatch = useMemo(
    () => serializeSelectedHunks(parsedFiles, acceptance),
    [parsedFiles, acceptance],
  );

  const handleToggleHunk = useCallback((key: string, next: boolean) => {
    setAcceptance((prev) => ({ ...prev, [key]: next }));
  }, []);

  const handleAcceptAll = useCallback(() => {
    setAcceptance(() => {
      const next: Record<string, boolean> = {};
      for (const file of parsedFiles) {
        for (let idx = 0; idx < file.hunks.length; idx += 1) next[hunkKey(file, idx)] = true;
      }
      return next;
    });
  }, [parsedFiles]);

  const handleSkipAll = useCallback(() => {
    setAcceptance(() => {
      const next: Record<string, boolean> = {};
      for (const file of parsedFiles) {
        for (let idx = 0; idx < file.hunks.length; idx += 1) next[hunkKey(file, idx)] = false;
      }
      return next;
    });
  }, [parsedFiles]);

  const handleCopyPatch = useCallback(async () => {
    if (!partialPatch) return;
    try {
      await navigator.clipboard.writeText(partialPatch);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch (error) {
      console.warn('[inline-diff] copy patch failed', error);
    }
  }, [partialPatch]);

  const handleMergeLane = useCallback(async () => {
    if (!packetId) return;
    setMerge({ status: 'pending', message: null });
    try {
      const { response, payload: data } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        result?: { merged?: boolean; status?: string; inProgress?: boolean; note?: string };
        error?: { message?: string } | string;
      }>('/api/orchestrator/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetId, idempotencyKey: crypto.randomUUID() }),
      });
      if (!response.ok || !data?.ok) {
        const reason = typeof data?.error === 'string'
          ? data.error
          : data?.error?.message ?? `Merge failed (HTTP ${response.status})`;
        setMerge({ status: 'error', message: reason });
        return;
      }
      if (actionReceiptIsInProgress(response.status, data.result)) {
        setMerge({
          status: 'pending',
          message: data.result?.note ?? 'This merge is already in progress.',
        });
        return;
      }
      const merged = Boolean(data.result?.merged);
      setMerge({
        status: 'success',
        message: merged
          ? 'Merged. Approval and merge pipeline completed.'
          : data.result?.status
          ? `Merge accepted. Status: ${data.result.status}.`
          : 'Merge accepted.',
      });
    } catch (error) {
      if (correlatedActionIsUnsettled(error)) {
        setMerge({ status: 'pending', message: error.message });
        return;
      }
      setMerge({
        status: 'error',
        message: error instanceof Error ? error.message : 'Merge failed.',
      });
    }
  }, [packetId]);

  const jumpToFile = useCallback((filePath: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector(`#${fileAnchorId(filePath)}`);
    if (target instanceof HTMLElement) {
      // Use getBoundingClientRect so the offset is relative to the scroll
      // container, not the nearest positioned offsetParent (which may differ).
      const top =
        target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      root.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
    }
  }, []);

  const headerLabel = title?.trim() || (packetId ? 'Packet review' : 'Worktree diff');
  const subHeader = useMemo(() => {
    const parts: string[] = [];
    if (payload?.baseBranch) parts.push(`Base: ${payload.baseBranch}`);
    if (payload?.worktreePath) parts.push(payload.worktreePath);
    return parts.join(' · ');
  }, [payload?.baseBranch, payload?.worktreePath]);

  const totalAdditions = payload?.additions ?? 0;
  const totalDeletions = payload?.deletions ?? 0;
  const fileCount = payload?.fileCount ?? parsedFiles.length;
  const noContext = !packetId && !sessionKey && !worktreePath;

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    background: 'var(--t-canvas-bg)',
  };

  return (
    <div style={containerStyle}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          paddingTop: 12,
          paddingRight: 16,
          paddingBottom: 12,
          paddingLeft: 20,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(20px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--t-text-strong)',
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {headerLabel}
          </span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--t-text-secondary)',
              fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {fileCount} file{fileCount === 1 ? '' : 's'} changed
            <span style={{ color: '#16a34a', marginLeft: 8 }}>+{totalAdditions}</span>
            <span style={{ color: '#dc2626', marginLeft: 6 }}>-{totalDeletions}</span>
            {subHeader ? <span style={{ marginLeft: 10, color: 'var(--t-text-faint)' }}>{subHeader}</span> : null}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void loadDiff()}
          title="Refresh diff"
          aria-label="Refresh diff"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            flexShrink: 0,
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {parsedFiles.length > 1 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 8,
            paddingRight: 16,
            paddingBottom: 8,
            paddingLeft: 20,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
            background: 'var(--t-bg-subtle)',
            overflowX: 'auto',
            flexShrink: 0,
          }}
        >
          {parsedFiles.map((file) => {
            const tone = statusTone(file.status);
            return (
              <button
                key={file.filePath}
                type="button"
                onClick={() => jumpToFile(file.filePath)}
                title={file.filePath}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  flexShrink: 0,
                  paddingTop: 6,
                  paddingRight: 10,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  minHeight: 28,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-divider)',
                  background: 'var(--t-panel)',
                  color: 'var(--t-text-secondary)',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
                  cursor: 'pointer',
                  letterSpacing: '-0.01em',
                  whiteSpace: 'nowrap',
                  maxWidth: 240,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: tone.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {basename(file.filePath)}
                </span>
                {dirname(file.filePath) ? (
                  <span
                    style={{
                      color: 'var(--t-text-faint)',
                      fontSize: 10,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {dirname(file.filePath)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          paddingTop: 14,
          paddingBottom: 14,
        }}
      >
        {loading && !payload ? (
          <div
            style={{
              fontSize: 13,
              color: 'var(--t-text-muted)',
              textAlign: 'center',
              marginTop: 32,
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            Loading diff…
          </div>
        ) : null}

        {!loading && noContext ? (
          <div
            style={{
              marginTop: 32,
              marginLeft: 'auto',
              marginRight: 'auto',
              maxWidth: 420,
              paddingTop: 14,
              paddingRight: 16,
              paddingBottom: 14,
              paddingLeft: 16,
              borderRadius: 14,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider)',
              background: 'var(--t-panel)',
              color: 'var(--t-text-secondary)',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            Open this view from a packet that&apos;s <strong>awaiting_review</strong> to load its worktree diff.
            Without a session or worktree path, there&apos;s nothing to compare against.
          </div>
        ) : null}

        {!loading && fetchError && !noContext ? (
          <div
            style={{
              marginTop: 24,
              marginLeft: 20,
              marginRight: 20,
              paddingTop: 10,
              paddingRight: 12,
              paddingBottom: 10,
              paddingLeft: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(239, 68, 68, 0.24)',
              background: 'rgba(239, 68, 68, 0.06)',
              color: '#dc2626',
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            {fetchError}
          </div>
        ) : null}

        {!loading && !fetchError && parsedFiles.length === 0 && payload ? (
          <div
            style={{
              fontSize: 13,
              color: 'var(--t-text-muted)',
              textAlign: 'center',
              marginTop: 32,
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            Worktree clean — nothing to review.
          </div>
        ) : null}

        {parsedFiles.map((file) => (
          <FileSection
            key={file.filePath}
            file={file}
            acceptance={acceptance}
            onToggleHunk={handleToggleHunk}
          />
        ))}
      </div>

      <div
        style={{
          flexShrink: 0,
          borderTopWidth: 1,
          borderTopStyle: 'solid',
          borderTopColor: 'var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          backdropFilter: 'blur(20px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
          paddingTop: 10,
          paddingRight: 16,
          paddingBottom: 10,
          paddingLeft: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--t-text-secondary)',
            fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
            letterSpacing: '0.04em',
          }}
        >
          {acceptedHunkCount}/{totalHunkCount} hunk{totalHunkCount === 1 ? '' : 's'} accepted
          {laneId ? <span style={{ marginLeft: 10, color: 'var(--t-text-faint)' }}>(lane {laneId.slice(0, 8)})</span> : null}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={handleAcceptAll}
          disabled={totalHunkCount === 0}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 6,
            paddingRight: 10,
            paddingBottom: 6,
            paddingLeft: 10,
            minHeight: 30,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            cursor: totalHunkCount === 0 ? 'default' : 'pointer',
            opacity: totalHunkCount === 0 ? 0.5 : 1,
            letterSpacing: '-0.01em',
          }}
        >
          Accept all
        </button>
        <button
          type="button"
          onClick={handleSkipAll}
          disabled={totalHunkCount === 0}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            paddingTop: 6,
            paddingRight: 10,
            paddingBottom: 6,
            paddingLeft: 10,
            minHeight: 30,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            cursor: totalHunkCount === 0 ? 'default' : 'pointer',
            opacity: totalHunkCount === 0 ? 0.5 : 1,
            letterSpacing: '-0.01em',
          }}
        >
          Skip all
        </button>
        <button
          type="button"
          onClick={() => void handleCopyPatch()}
          disabled={!partialPatch}
          title={partialPatch ? 'Copy a unified diff containing only the accepted hunks' : 'No accepted hunks to copy'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            paddingTop: 6,
            paddingRight: 10,
            paddingBottom: 6,
            paddingLeft: 10,
            minHeight: 30,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider)',
            background: 'transparent',
            color: copyState === 'copied' ? '#16a34a' : 'var(--t-text-secondary)',
            fontSize: 11,
            fontWeight: 600,
            cursor: !partialPatch ? 'default' : 'pointer',
            opacity: !partialPatch ? 0.5 : 1,
            letterSpacing: '-0.01em',
          }}
        >
          {copyState === 'copied' ? <Check size={11} /> : <Copy size={11} />}
          {copyState === 'copied' ? 'Copied' : 'Copy patch'}
        </button>
        <button
          type="button"
          onClick={() => void handleMergeLane()}
          disabled={!packetId || merge.status === 'pending' || acceptedHunkCount === 0}
          title={
            !packetId
              ? 'Open from an awaiting_review packet to enable merging'
              : acceptedHunkCount === 0
              ? 'Accept at least one hunk to merge'
              : 'Run the approval + merge pipeline for this packet'
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            paddingTop: 6,
            paddingRight: 12,
            paddingBottom: 6,
            paddingLeft: 12,
            minHeight: 30,
            borderRadius: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor:
              merge.status === 'success'
                ? 'rgba(34, 197, 94, 0.32)'
                : merge.status === 'error'
                ? 'rgba(239, 68, 68, 0.32)'
                : 'rgba(37, 99, 235, 0.28)',
            background:
              merge.status === 'success'
                ? 'rgba(34, 197, 94, 0.10)'
                : merge.status === 'error'
                ? 'rgba(239, 68, 68, 0.06)'
                : '#2563eb',
            color:
              merge.status === 'success'
                ? '#15803d'
                : merge.status === 'error'
                ? '#b91c1c'
                : '#fff',
            fontSize: 11,
            fontWeight: 700,
            cursor: !packetId || merge.status === 'pending' || acceptedHunkCount === 0 ? 'default' : 'pointer',
            opacity: !packetId || acceptedHunkCount === 0 ? 0.55 : 1,
            letterSpacing: '-0.01em',
          }}
        >
          <GitMerge size={11} />
          {merge.status === 'pending' ? 'Merging…' : merge.status === 'success' ? 'Merged' : 'Merge lane'}
        </button>
      </div>

      {merge.message ? (
        <div
          style={{
            paddingTop: 6,
            paddingRight: 20,
            paddingBottom: 8,
            paddingLeft: 20,
            fontSize: 11,
            fontWeight: 600,
            color: merge.status === 'error' ? '#b91c1c' : merge.status === 'success' ? '#15803d' : 'var(--t-text-secondary)',
            background:
              merge.status === 'error'
                ? 'rgba(239, 68, 68, 0.06)'
                : merge.status === 'success'
                ? 'rgba(34, 197, 94, 0.08)'
                : 'transparent',
            borderTopWidth: merge.status === 'idle' ? 0 : 1,
            borderTopStyle: 'solid',
            borderTopColor: 'var(--t-divider-subtle)',
            flexShrink: 0,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {merge.message}
        </div>
      ) : null}
    </div>
  );
});
