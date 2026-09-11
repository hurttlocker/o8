'use client';

/**
 * #2144 — the Review surface's state for a lane whose checkout is gone.
 *
 * Before this, the only thing the panel could say was "Failed to load review
 * lane diff", which reads as "try again" when the truth is that there is
 * nothing left to load and the lane can never leave the escalated set on its
 * own. This state says so plainly and carries the one action that ends it.
 *
 * The discard is a deliberate two-step: an escalated lane means o8 is blocked
 * on a human, so the operator confirms before the lane is retired.
 */

import { useState } from 'react';
import { MONO_FONT, UI_FONT } from './constants';

export function MissingWorktreeNotice({
  laneId,
  detail,
  onDiscarded,
}: {
  laneId: string;
  detail: string;
  onDiscarded?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const discard = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch('/api/lanes/discard-orphaned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ laneId }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: { message?: string } | null; note?: string } | null;
      if (!res.ok || !body?.ok) {
        setFailure(body?.error?.message ?? body?.note ?? `Discard failed with status ${res.status}`);
        return;
      }
      setConfirming(false);
      // Every lane consumer refetches — the rail, the Archived section, and the
      // parked-lane count behind the mission-bar badge and the overlay pill.
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
      onDiscarded?.();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Discard failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ paddingTop: 18, paddingRight: 16, paddingBottom: 18, paddingLeft: 16, fontFamily: UI_FONT, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560 }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--t-text-primary)', letterSpacing: '-0.1px' }}>
        Worktree no longer on disk
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-muted)' }}>
        This lane&rsquo;s checkout was removed while the lane was still open, so there is no diff left
        to review and no work left to recover. Discarding closes the lane and clears it from the
        escalated count.
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-faint)', fontFamily: MONO_FONT, wordBreak: 'break-word' }}>
        {detail}
      </div>

      {failure ? (
        <div style={{ fontSize: 11.5, color: 'var(--t-tone-fail)' }}>{failure}</div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => { void discard(); }}
              disabled={busy}
              style={{
                height: 26,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 7,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-tone-fail-border)',
                background: 'var(--t-tone-fail-bg)',
                color: 'var(--t-tone-fail)',
                cursor: busy ? 'default' : 'pointer',
                fontFamily: UI_FONT,
                fontSize: 11.5,
                fontWeight: 600,
                letterSpacing: '-0.1px',
              }}
            >
              {busy ? 'Discarding…' : 'Confirm discard'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              style={{
                height: 26,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 7,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider-subtle)',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text-muted)',
                cursor: busy ? 'default' : 'pointer',
                fontFamily: UI_FONT,
                fontSize: 11.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            style={{
              height: 26,
              paddingLeft: 10,
              paddingRight: 10,
              borderRadius: 7,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              fontFamily: UI_FONT,
              fontSize: 11.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
            }}
          >
            Discard lane
          </button>
        )}
      </div>
    </div>
  );
}
