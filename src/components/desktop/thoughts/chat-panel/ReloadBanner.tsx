/**
 * One-line banner rendered in the orchestrator chat while a conversational
 * MCP install is reloading. Fired from the ws-server orchestrator channel
 * via the new `notice` event (kind === "mcp-reload"). Auto-dismisses after
 * AUTO_DISMISS_MS so the UI never gets stuck if the follow-up never arrives.
 *
 * Inline styles only per the repo's never-CSS-classes rule.
 */
'use client';

import { useEffect, useState } from 'react';

export const RELOAD_BANNER_AUTO_DISMISS_MS = 6_000;

export interface ReloadBannerProps {
  /** Unique id for the active notice (changes = new banner). */
  noticeId: string;
  /** Primary message. */
  message: string;
  /** Optional sub-line. */
  detail?: string;
  /** Fired when the elapsed timer dismisses the banner. */
  onDismiss?: () => void;
}

export function ReloadBanner(props: ReloadBannerProps) {
  const { noticeId, message, detail, onDismiss } = props;
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const tick = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    const dismiss = window.setTimeout(() => {
      onDismiss?.();
    }, RELOAD_BANNER_AUTO_DISMISS_MS);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(dismiss);
    };
  }, [noticeId, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingTop: 6,
        paddingRight: 10,
        paddingBottom: 6,
        paddingLeft: 10,
        borderRadius: 10,
        border: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-panel-translucent)',
        color: 'var(--t-text-muted)',
        fontSize: 11,
        fontFamily: '"iA Writer Mono", "SF Mono", ui-monospace, monospace',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--t-accent, #2563eb)',
            display: 'inline-block',
          }}
        />
        <span>{message}</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {detail ? <span style={{ opacity: 0.7 }}>{detail}</span> : null}
        <span style={{ opacity: 0.7 }}>{elapsed}s</span>
      </span>
    </div>
  );
}
