'use client';

/**
 * DevHostFrame — the right-side iframe in the mobile landscape split shell.
 *
 * Renders the user's LAN dev server (e.g. http://192.168.1.42:3001) inside
 * an iframe with a Safari-quality URL bar above it. Address typeahead pulls
 * from /api/panel/ports + /api/panel/lan-host so the user can jump to any
 * registered repo's dev port. Sites that block embedding (X-Frame-Options
 * DENY, strict CSP) fall back to a clear "blocked" empty state with an
 * external-open link.
 *
 * iOS PWA caveat: if o8 itself is served https://, Safari blocks mixed-
 * content http:// iframes silently. The empty state surfaces this so the
 * user knows to either run o8 over http://lan-ip or wait for the v2
 * mkcert proxy.
 *
 * Owned by the mobile-dev-host-frame agent. The split-shell layout
 * (#779) imports this component and mounts it in the right pane.
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

/* ── Phosphor SVG path data (regular weight, 256×256 viewBox) ───────────── */
/* Inlined per repo policy: no React icon components in the Tauri webview.   */
const PHOSPHOR_PATHS = {
  CaretLeft:
    'M165.66,202.34a8,8,0,0,1-11.32,11.32l-80-80a8,8,0,0,1,0-11.32l80-80a8,8,0,0,1,11.32,11.32L91.31,128Z',
  CaretRight:
    'M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z',
  ArrowClockwise:
    'M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z',
  ArrowSquareOut:
    'M200,64V168a8,8,0,0,1-16,0V83.31L69.66,197.66a8,8,0,0,1-11.32-11.32L172.69,72H88a8,8,0,0,1,0-16H192A8,8,0,0,1,200,64Z',
  WarningCircle:
    'M128,24A104,104,0,1,0,232,128,104.13,104.13,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z',
} as const;

/* ── Public API ─────────────────────────────────────────────────────────── */

export interface DevHostFrameHandle {
  back(): void;
  forward(): void;
  reload(): void;
}

export interface DevHostFrameProps {
  initialUrl?: string;
  onUrlChange?(url: string): void;
}

/* ── Internals ──────────────────────────────────────────────────────────── */

const MONO_FAMILY = '"SF Mono", Menlo, ui-monospace, monospace';
const SANS_FAMILY = '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
const HOSTILE_TIMEOUT_MS = 4_000;

interface PortsResponse {
  ports?: { port: number; repo: string | null }[];
  groups?: { repo: string; ports: number[] }[];
}

interface LanHostResponse {
  lanIp: string | null;
  ports: number[];
}

interface Suggestion {
  url: string;
  label: string;
  hint?: string;
}

/**
 * URLs we consider trustworthy for an iframe. Public sites usually block
 * embedding — for those we let the 4s onload timer fire the empty state.
 * Local dev hosts almost always allow embedding (or the user controls
 * them) — for those we skip the timer entirely so the empty state never
 * misfires while a heavy bundle loads.
 */
function isLocalDevHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (host === '127.0.0.1' || host.startsWith('127.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('172.')) {
    const parts = host.split('.');
    const second = parts.length >= 2 ? parseInt(parts[1], 10) : NaN;
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  return false;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isMixedContentBlocked(url: string): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol !== 'https:') return false;
  return /^http:\/\//i.test(url);
}

/* ── Component ──────────────────────────────────────────────────────────── */

export const DevHostFrame = memo(
  forwardRef<DevHostFrameHandle, DevHostFrameProps>(function DevHostFrame(
    { initialUrl, onUrlChange },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const hostileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [committedUrl, setCommittedUrl] = useState<string>(initialUrl ?? '');
    const [draftUrl, setDraftUrl] = useState<string>(initialUrl ?? '');
    const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
    const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ok' | 'blocked' | 'mixed'>(
      initialUrl ? 'loading' : 'idle',
    );
    const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
    const [bootDefault, setBootDefault] = useState<{ url: string; lanIp: string | null } | null>(
      null,
    );

    /* ── Fetch typeahead data once on mount ─────────────────────────────── */
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const [portsRes, lanRes] = await Promise.all([
            fetch('/api/panel/ports').then((r) => (r.ok ? (r.json() as Promise<PortsResponse>) : null)),
            fetch('/api/panel/lan-host').then((r) =>
              r.ok ? (r.json() as Promise<LanHostResponse>) : null,
            ),
          ]);
          if (cancelled) return;

          const lanIp = lanRes?.lanIp ?? null;
          const items: Suggestion[] = [];
          const seenUrls = new Set<string>();

          // Per-repo group entries first — these are the labelled
          // "this repo's dev server" shortcuts.
          if (portsRes?.groups) {
            for (const group of portsRes.groups) {
              for (const port of group.ports) {
                const url = `http://${lanIp ?? 'localhost'}:${port}`;
                if (seenUrls.has(url)) continue;
                seenUrls.add(url);
                items.push({
                  url,
                  label: `${group.repo}:${port}`,
                  hint: lanIp ? `${lanIp}:${port}` : `localhost:${port}`,
                });
              }
            }
          }

          // Fall through to any LAN ports the panel scan didn't tag with
          // a repo — still useful as bare endpoints.
          const fallbackPorts = lanRes?.ports ?? [];
          for (const port of fallbackPorts) {
            const url = `http://${lanIp ?? 'localhost'}:${port}`;
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            items.push({
              url,
              label: `localhost:${port}`,
              hint: lanIp ? `${lanIp}:${port}` : undefined,
            });
          }

          setSuggestions(items);

          // Default URL = first repo-tagged port over LAN if we have one.
          if (!initialUrl && items.length > 0) {
            setBootDefault({ url: items[0].url, lanIp });
            setCommittedUrl(items[0].url);
            setDraftUrl(items[0].url);
            setLoadState('loading');
            onUrlChange?.(items[0].url);
          } else if (!initialUrl) {
            setBootDefault({ url: '', lanIp });
          }
        } catch {
          // Typeahead is best-effort — keep going with a blank URL bar.
          if (!cancelled) setBootDefault({ url: '', lanIp: null });
        }
      })();

      return () => {
        cancelled = true;
      };
      // We intentionally only run this once on mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* ── Imperative handle for parent split-shell controls ──────────────── */
    useImperativeHandle(
      ref,
      () => ({
        back: () => {
          try {
            iframeRef.current?.contentWindow?.history.back();
          } catch {
            /* cross-origin frames throw — silent no-op */
          }
        },
        forward: () => {
          try {
            iframeRef.current?.contentWindow?.history.forward();
          } catch {
            /* cross-origin frames throw — silent no-op */
          }
        },
        reload: () => {
          if (!committedUrl) return;
          // Force re-mount by toggling state; iframe.location.reload() also
          // throws on cross-origin frames, so we re-set the src instead.
          setLoadState('loading');
          if (iframeRef.current) {
            iframeRef.current.src = committedUrl;
          }
          armHostileTimer(committedUrl);
        },
      }),
      // armHostileTimer is stable via useCallback below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [committedUrl],
    );

    /* ── 4-second hostile-iframe detector ───────────────────────────────── */
    const clearHostileTimer = useCallback(() => {
      if (hostileTimerRef.current) {
        clearTimeout(hostileTimerRef.current);
        hostileTimerRef.current = null;
      }
    }, []);

    const armHostileTimer = useCallback(
      (url: string) => {
        clearHostileTimer();
        // Skip the timer entirely for known-good local dev hosts. They
        // can take >4s to first-paint while a Webpack/Next bundle compiles.
        if (isLocalDevHost(url)) return;
        hostileTimerRef.current = setTimeout(() => {
          // If we still haven't seen onload, assume the site refused embedding.
          setLoadState((prev) => (prev === 'loading' ? 'blocked' : prev));
        }, HOSTILE_TIMEOUT_MS);
      },
      [clearHostileTimer],
    );

    /* ── Commit a URL: validate, set src, arm hostile timer ─────────────── */
    const commitUrl = useCallback(
      (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) return;
        if (!isHttpUrl(trimmed)) {
          // Treat raw "192.168.1.42:3001" as http://192.168.1.42:3001
          const fallback = `http://${trimmed.replace(/^\/+/, '')}`;
          if (!isHttpUrl(fallback)) return;
          return commitUrl(fallback);
        }
        if (isMixedContentBlocked(trimmed)) {
          setCommittedUrl(trimmed);
          setLoadState('mixed');
          onUrlChange?.(trimmed);
          return;
        }
        setCommittedUrl(trimmed);
        setDraftUrl(trimmed);
        setShowSuggestions(false);
        setLoadState('loading');
        armHostileTimer(trimmed);
        onUrlChange?.(trimmed);
      },
      [armHostileTimer, onUrlChange],
    );

    /* ── Initial URL → arm timer on first paint ─────────────────────────── */
    useEffect(() => {
      if (committedUrl && loadState === 'loading') {
        armHostileTimer(committedUrl);
      }
      return clearHostileTimer;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [committedUrl]);

    /* ── Iframe load handlers ───────────────────────────────────────────── */
    const onIframeLoad = useCallback(() => {
      clearHostileTimer();
      // contentDocument is null for cross-origin iframes — that's normal,
      // not a sign of blocking. Just trust the onload event firing.
      setLoadState('ok');
    }, [clearHostileTimer]);

    const onIframeError = useCallback(() => {
      clearHostileTimer();
      setLoadState('blocked');
    }, [clearHostileTimer]);

    /* ── URL bar interactions ───────────────────────────────────────────── */
    const onSubmit = useCallback(
      (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        commitUrl(draftUrl);
      },
      [commitUrl, draftUrl],
    );

    const onClickSuggestion = useCallback(
      (item: Suggestion) => {
        commitUrl(item.url);
        inputRef.current?.blur();
      },
      [commitUrl],
    );

    /* ── Filtered typeahead based on current draft ──────────────────────── */
    const visibleSuggestions = useMemo(() => {
      if (!showSuggestions) return [] as Suggestion[];
      const q = draftUrl.trim().toLowerCase();
      if (!q) return suggestions;
      return suggestions.filter(
        (s) =>
          s.url.toLowerCase().includes(q) ||
          s.label.toLowerCase().includes(q) ||
          (s.hint?.toLowerCase().includes(q) ?? false),
      );
    }, [draftUrl, showSuggestions, suggestions]);

    /* ── Render ─────────────────────────────────────────────────────────── */
    return (
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--t-bg)',
          fontFamily: SANS_FAMILY,
          color: 'var(--t-text)',
          overscrollBehavior: 'contain',
        }}
      >
        {/* ── URL bar ─────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 'max(8px, env(safe-area-inset-top))',
            paddingBottom: 8,
            paddingLeft: 'max(10px, env(safe-area-inset-left))',
            paddingRight: 'max(10px, env(safe-area-inset-right))',
            background: 'var(--t-panel)',
            borderBottom: '1px solid var(--t-panel-border)',
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            flexShrink: 0,
            zIndex: 2,
          }}
        >
          <NavButton
            label="Back"
            onClick={() => {
              try {
                iframeRef.current?.contentWindow?.history.back();
              } catch {
                /* no-op */
              }
            }}
            iconPath={PHOSPHOR_PATHS.CaretLeft}
          />
          <NavButton
            label="Forward"
            onClick={() => {
              try {
                iframeRef.current?.contentWindow?.history.forward();
              } catch {
                /* no-op */
              }
            }}
            iconPath={PHOSPHOR_PATHS.CaretRight}
          />
          <NavButton
            label="Reload"
            onClick={() => {
              if (!committedUrl) return;
              setLoadState('loading');
              if (iframeRef.current) iframeRef.current.src = committedUrl;
              armHostileTimer(committedUrl);
            }}
            iconPath={PHOSPHOR_PATHS.ArrowClockwise}
          />

          <form onSubmit={onSubmit} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
            <input
              ref={inputRef}
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={
                bootDefault?.lanIp
                  ? `http://${bootDefault.lanIp}:port`
                  : 'Type a dev host URL'
              }
              value={draftUrl}
              onChange={(e) => {
                setDraftUrl(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => {
                // Delay so a tap on a suggestion still fires.
                window.setTimeout(() => setShowSuggestions(false), 120);
              }}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid var(--t-panel-border)',
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                fontFamily: MONO_FAMILY,
                fontSize: 13,
                lineHeight: '20px',
                outline: 'none',
                boxSizing: 'border-box',
                WebkitAppearance: 'none',
                appearance: 'none',
              }}
            />
            {visibleSuggestions.length > 0 ? (
              <ul
                role="listbox"
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  right: 0,
                  margin: 0,
                  padding: 4,
                  listStyle: 'none',
                  background: 'var(--t-panel-solid)',
                  border: '1px solid var(--t-panel-border)',
                  borderRadius: 12,
                  boxShadow: 'var(--t-panel-shadow)',
                  maxHeight: 240,
                  overflowY: 'auto',
                  zIndex: 5,
                  backdropFilter: 'blur(24px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                }}
              >
                {visibleSuggestions.map((item) => (
                  <li key={item.url}>
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        // Prevent the input from blurring before the click fires.
                        e.preventDefault();
                      }}
                      onClick={() => onClickSuggestion(item)}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 8,
                        width: '100%',
                        padding: '10px 12px',
                        minHeight: 44,
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--t-text)',
                        textAlign: 'left',
                        borderRadius: 8,
                        cursor: 'pointer',
                        fontFamily: SANS_FAMILY,
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{item.label}</span>
                      <span
                        style={{
                          fontFamily: MONO_FAMILY,
                          fontSize: 11,
                          color: 'var(--t-text-muted)',
                          marginLeft: 'auto',
                        }}
                      >
                        {item.hint ?? item.url.replace(/^https?:\/\//, '')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </form>
        </div>

        {/* ── Iframe / empty states ──────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            background: 'var(--t-bg)',
          }}
        >
          {loadState === 'idle' && !committedUrl ? (
            <IdleState lanIp={bootDefault?.lanIp ?? null} />
          ) : loadState === 'blocked' ? (
            <BlockedState
              url={committedUrl}
              kind="frame"
              onRetry={() => {
                setLoadState('loading');
                if (iframeRef.current) iframeRef.current.src = committedUrl;
                armHostileTimer(committedUrl);
              }}
            />
          ) : loadState === 'mixed' ? (
            <BlockedState url={committedUrl} kind="mixed" onRetry={null} />
          ) : null}

          {committedUrl && loadState !== 'mixed' ? (
            <iframe
              ref={iframeRef}
              src={committedUrl}
              title="Dev host preview"
              onLoad={onIframeLoad}
              onError={onIframeError}
              sandbox="allow-scripts allow-same-origin allow-forms"
              referrerPolicy="no-referrer"
              allow="clipboard-read; clipboard-write"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                border: 'none',
                background: 'var(--t-bg)',
                // Keep the iframe in the DOM during 'blocked' so retry just
                // toggles state, but visually hide it under the empty state.
                visibility: loadState === 'blocked' ? 'hidden' : 'visible',
              }}
            />
          ) : null}
        </div>
      </div>
    );
  }),
);

DevHostFrame.displayName = 'DevHostFrame';

/* ── Subcomponents ─────────────────────────────────────────────────────── */

interface NavButtonProps {
  label: string;
  iconPath: string;
  onClick(): void;
}

function NavButton({ label, iconPath, onClick }: NavButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: 36,
        height: 36,
        minWidth: 36,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-panel-translucent)',
        color: 'var(--t-text-secondary)',
        borderRadius: 10,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={16}
        height={16}
        fill="currentColor"
        viewBox="0 0 256 256"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <path d={iconPath} />
      </svg>
    </button>
  );
}

interface BlockedStateProps {
  url: string;
  kind: 'frame' | 'mixed';
  onRetry: (() => void) | null;
}

function BlockedState({ url, kind, onRetry }: BlockedStateProps) {
  const title =
    kind === 'mixed'
      ? 'Mixed-content blocked by iOS'
      : 'This site blocks embedding';
  const detail =
    kind === 'mixed'
      ? 'Safari refuses to load http:// inside an https:// app. Serve o8 over http:// from your dev box, or wait for the v2 mkcert proxy.'
      : 'The site set X-Frame-Options or a strict CSP. Open it externally to view it.';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'max(24px, env(safe-area-inset-bottom))',
        textAlign: 'center',
        gap: 14,
        zIndex: 1,
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={32}
        height={32}
        viewBox="0 0 256 256"
        fill="var(--t-text-muted)"
        style={{ opacity: 0.7 }}
      >
        <path d={PHOSPHOR_PATHS.WarningCircle} />
      </svg>
      <div
        style={{
          fontFamily: SANS_FAMILY,
          fontSize: 15,
          fontWeight: 600,
          color: 'var(--t-text)',
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: SANS_FAMILY,
          fontSize: 13,
          lineHeight: 1.4,
          color: 'var(--t-text-secondary)',
          maxWidth: 360,
        }}
      >
        {detail}
      </div>
      <div
        style={{
          fontFamily: MONO_FAMILY,
          fontSize: 11,
          color: 'var(--t-text-muted)',
          maxWidth: '100%',
          overflowWrap: 'anywhere',
          padding: '6px 10px',
          background: 'var(--t-bg-card)',
          borderRadius: 8,
          border: '1px solid var(--t-panel-border)',
        }}
      >
        {url || '—'}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            style={{
              padding: '8px 14px',
              minHeight: 36,
              borderRadius: 10,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-panel-translucent)',
              color: 'var(--t-text)',
              fontFamily: SANS_FAMILY,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        ) : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 14px',
              minHeight: 36,
              borderRadius: 10,
              border: '1px solid var(--t-panel-border)',
              background: 'var(--t-panel-active)',
              color: 'var(--t-text)',
              fontFamily: SANS_FAMILY,
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={14}
              height={14}
              fill="currentColor"
              viewBox="0 0 256 256"
            >
              <path d={PHOSPHOR_PATHS.ArrowSquareOut} />
            </svg>
            Open externally
          </a>
        ) : null}
      </div>
    </div>
  );
}

function IdleState({ lanIp }: { lanIp: string | null }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        textAlign: 'center',
        gap: 8,
      }}
    >
      <div
        style={{
          fontFamily: SANS_FAMILY,
          fontSize: 14,
          color: 'var(--t-text-secondary)',
        }}
      >
        Type a URL above to load your dev server.
      </div>
      {lanIp ? (
        <div
          style={{
            fontFamily: MONO_FAMILY,
            fontSize: 12,
            color: 'var(--t-text-muted)',
          }}
        >
          LAN host: {lanIp}
        </div>
      ) : null}
    </div>
  );
}
