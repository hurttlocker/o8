'use client';
/* eslint-disable @next/next/no-img-element -- terminal image previews intentionally use raw panel-served URLs */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme/context';
import { buildXtermTheme } from '@/components/desktop/workspace-terminal/constants';
import { startSpawnReveal } from '@/components/desktop/workspace-terminal/spawn-reveal';
import { recordXtermSelectionSnapshot, registerXtermSelectionSource } from '@/components/desktop/workspace-terminal/xterm-selection-registry';
import { retainInlineTerminalImages, TERMINAL_SCROLLBACK_LINES } from '@/lib/terminal/client-retention';

export interface InlineImage {
  id: string;
  dataUrl: string;
  filename: string;
}

export interface XtermPanelProps {
  tmuxSession: string;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
  /** Render with no background so the host surface (canvas glass) reads
   *  through. The host owns legibility (its own tint/veil behind the text). */
  transparent?: boolean;
  /** Override the terminal font size (default 12). */
  fontSize?: number;
  /** Override the line-height multiplier (default 1.35). The canvas passes 1.0
   *  so xterm's DOM-renderer selection overlay aligns with the glyph baseline —
   *  1.35 offsets the highlight ~½ line up from the text under CSS zoom (#1245). */
  lineHeight?: number;
  /** Bump on every WebSocket (re)connect. Terminal sends drop silently on a
   *  closed socket and the server never re-attaches us — without this, any
   *  transport bounce leaves the view permanently deaf while the pty lives
   *  on. Each bump resets the buffer and re-attaches; the server replays
   *  scrollback, so the repaint is idempotent. */
  connectionEpoch?: number;
  /** One-shot "o8" materialization in the dead air between attach and the
   *  first prompt byte — written into the view only (never the PTY), and
   *  cancelled the instant real data arrives. */
  spawnReveal?: boolean;
  /** Guarantee the sweep + shimmer play even when the shell beats them:
   *  PTY data is buffered (~800ms worst case) and flushed at the hold
   *  point. For the occasional "show it anyway" spawn — never the default,
   *  because it trades real latency for the moment. */
  revealMinPlay?: boolean;
  /** Surface-scoped xterm theme keys merged OVER the built theme — the
   *  canvas passes its own ink so terminals follow the glass vocabulary
   *  instead of whatever --t-terminal-* happens to be stamped globally. */
  themeOverrides?: Record<string, string>;
}

export interface XtermPanelHandle {
  focus: () => void;
  writeData: (data: string) => void;
  writeRaw: (data: string) => void;
  readText: (lines?: number) => string;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: () => void;
}

export const XtermPanel = forwardRef<XtermPanelHandle, XtermPanelProps>(function XtermPanel(
  { tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, visible, transparent, fontSize, lineHeight, connectionEpoch, spawnReveal, revealMinPlay, themeOverrides },
  ref,
) {
  const { themeId } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const revealCancelRef = useRef<((resetTerm: boolean) => void) | null>(null);
  /** While true, incoming PTY chunks queue instead of painting (min-play). */
  const revealHoldRef = useRef(false);
  const pendingChunksRef = useRef<string[]>([]);

  /** Real output is about to paint — kill the reveal, clean slate.
   *  Ref nulls BEFORE invoking so re-entrant calls (the cancel fires the
   *  reveal's hold-point, whose handler may cancel again) are no-ops. */
  const cancelReveal = (resetTerm: boolean) => {
    const cancel = revealCancelRef.current;
    if (!cancel) return;
    revealCancelRef.current = null;
    cancel(resetTerm);
  };
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const imageCountRef = useRef(0);

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    writeData: (data: string) => {
      if (!termRef.current) return;
      if (revealHoldRef.current) {
        // Min-play hold: queue the chunk; the reveal's hold-point flushes.
        pendingChunksRef.current.push(data);
        return;
      }
      cancelReveal(true);
      try {
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        termRef.current.write(bytes);
      } catch {
        return;
      }
    },
    showImage: (imageB64: string, filename: string) => {
      const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'svg'
            ? 'image/svg+xml'
            : 'image/png';
      const dataUrl = `data:${mime};base64,${imageB64}`;
      imageCountRef.current += 1;
      setInlineImages((previous) => retainInlineTerminalImages([
        ...previous,
        { id: `img-${imageCountRef.current}`, dataUrl, filename },
      ]));
      if (termRef.current) {
        termRef.current.write('\r\n\r\n');
      }
    },
    writeRaw: (data: string) => {
      if (!termRef.current) return;
      cancelReveal(true);
      try {
        const encoder = new TextEncoder();
        termRef.current.write(encoder.encode(data));
      } catch {
        return;
      }
    },
    readText: (lines = 40) => {
      const term = termRef.current;
      if (!term?.buffer?.active) return '';
      const active = term.buffer.active;
      const length = active.length ?? 0;
      const start = Math.max(0, length - Math.max(1, Math.floor(lines)));
      const out: string[] = [];
      for (let index = start; index < length; index += 1) {
        out.push(active.getLine(index)?.translateToString(true) ?? '');
      }
      return out.join('\n').replace(/\s+$/g, '');
    },
    setError: (nextError: string) => setError(nextError),
    setExited: () => setExited(true),
  }), []);

  useEffect(() => {
    if (visible && fitAddonRef.current) {
      const timer = setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          if (termRef.current) {
            sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          }
        } catch {
          return;
        }
      }, 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [visible, tmuxSession, sendTerminalResize]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    let disposed = false;

    async function init() {
      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { SearchAddon }, { Unicode11Addon }, { ImageAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-search'),
          import('@xterm/addon-unicode11'),
          import('@xterm/addon-image'),
        ]);
        if (disposed) return;

        if (!document.getElementById('xterm-css')) {
          const link = document.createElement('link');
          link.id = 'xterm-css';
          link.rel = 'stylesheet';
          link.href = '/xterm.css';
          document.head.appendChild(link);
        }

        const term = new Terminal({
          fontFamily: 'ui-monospace, "SF Mono", Monaco, Menlo, monospace',
          fontSize: fontSize ?? 12,
          lineHeight: lineHeight ?? 1.35,
          cursorBlink: true,
          cursorStyle: 'block',
          allowTransparency: transparent === true,
          allowProposedApi: true,
          scrollback: TERMINAL_SCROLLBACK_LINES,
          theme: {
            ...buildXtermTheme(),
            ...(transparent ? { background: 'rgba(0,0,0,0)' } : {}),
            ...(themeOverrides ?? {}),
          },
        });

        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();
        const searchAddon = new SearchAddon();
        const unicode11Addon = new Unicode11Addon();
        const imageAddon = new ImageAddon({
          enableSizeReports: true,
          pixelLimit: 16777216,
          sixelSupport: true,
          sixelScrolling: true,
          sixelPaletteLimit: 4096,
          iipSupport: true,
          iipSizeLimit: 20000000,
        });
        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);
        term.loadAddon(searchAddon);
        term.loadAddon(unicode11Addon);
        term.loadAddon(imageAddon);
        term.unicode.activeVersion = '11';

        if (!containerRef.current || disposed) {
          term.dispose();
          return;
        }

        term.open(containerRef.current);
        termRef.current = term;
        fitAddonRef.current = fitAddon;
        term.onData((data) => {
          sendTerminalInput(tmuxSession, data);
        });
        // Snapshot every selection for the speak-selection reader — busy TUIs
        // redraw and can wipe the live selection before the chord lands.
        term.onSelectionChange(() => {
          recordXtermSelectionSnapshot(term.getSelection?.() ?? '');
        });

        observerRef.current = new ResizeObserver(() => {
          if (disposed || !visibleRef.current || !fitAddonRef.current) return;
          try {
            fitAddonRef.current.fit();
            sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          } catch {
            return;
          }
        });
        if (containerRef.current) observerRef.current.observe(containerRef.current);

        // Fit on the next frame, NOT synchronously at open(). xterm measures its
        // cell box on the first render, and under the canvas CSS `zoom` a same-
        // tick fit reads stale metrics → wrong cols/rows. That mis-sized the
        // spawn reveal (the o8 glyph drew off-center on a stale grid) AND
        // attached the PTY at the wrong size, so a Claude TUI didn't fill/scroll
        // until a manual resize forced a refit. Double-rAF lets WebKit apply
        // layout + zoom before we measure; then we reveal + attach at the REAL
        // size. Reveal still starts before attach so no replay races it.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const liveTerm = termRef.current;
          if (disposed || !liveTerm || !fitAddonRef.current) return;
          try { fitAddonRef.current.fit(); } catch { /* disposed mid-fit */ }
          if (spawnReveal) {
            revealHoldRef.current = revealMinPlay === true;
            revealCancelRef.current = startSpawnReveal(liveTerm, {
              onHoldPoint: () => {
                revealHoldRef.current = false;
                if (pendingChunksRef.current.length === 0) return;
                const chunks = pendingChunksRef.current;
                pendingChunksRef.current = [];
                cancelReveal(true);
                if (!termRef.current) return;
                for (const chunk of chunks) {
                  try {
                    const bytes = Uint8Array.from(atob(chunk), (char) => char.charCodeAt(0));
                    termRef.current.write(bytes);
                  } catch {
                    // skip malformed chunk
                  }
                }
              },
            });
          }
          sendTerminalAttach(tmuxSession, liveTerm.cols, liveTerm.rows);
        }));
        return () => {
          observerRef.current?.disconnect();
          observerRef.current = null;
        };
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Failed to load terminal');
        }
      }
      return undefined;
    }

    const cleanupPromise = init();

    // Speak-selection bridge: expose this terminal's selection to the
    // dashboard's Ctrl+Shift+R handler (xterm selections are not DOM
    // selections — see xterm-selection-registry.ts).
    const unregisterSelection = registerXtermSelectionSource(
      () => termRef.current?.getSelection?.() ?? '',
    );

    return () => {
      disposed = true;
      unregisterSelection();
      cancelReveal(false);
      sendTerminalDetach(tmuxSession);
      observerRef.current?.disconnect();
      observerRef.current = null;
      cleanupPromise?.then((cleanup) => cleanup?.());
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancelReveal only touches refs
  }, [tmuxSession, sendTerminalAttach, sendTerminalDetach, sendTerminalInput, sendTerminalResize, transparent, fontSize, lineHeight, spawnReveal, revealMinPlay]);

  // Re-attach after a transport (re)connect. The init effect's attach is
  // dropped silently if the socket isn't open yet, and the server never
  // pushes attachments — so each connect epoch resets the buffer and
  // attaches again. The server replays scrollback into the clean buffer,
  // which makes a duplicate attach visually idempotent.
  useEffect(() => {
    if (connectionEpoch === undefined || connectionEpoch < 1) return;
    const term = termRef.current;
    if (!term) return;
    cancelReveal(false);
    try {
      term.reset();
      sendTerminalAttach(tmuxSession, term.cols, term.rows);
    } catch {
      // disposed mid-update; the next mount attaches fresh
    }

  }, [connectionEpoch, tmuxSession, sendTerminalAttach]);

  // Live-update xterm theme on theme switch without recreating the terminal.
  // The canvas repaints next frame with the new palette, PTY state is preserved.
  const themeOverridesKey = themeOverrides ? JSON.stringify(themeOverrides) : '';
  useEffect(() => {
    if (!termRef.current) return;
    try {
      termRef.current.options.theme = {
        ...buildXtermTheme(),
        ...(transparent ? { background: 'rgba(0,0,0,0)' } : {}),
        ...(themeOverridesKey ? JSON.parse(themeOverridesKey) : {}),
      };
    } catch {
      // xterm may throw if the terminal was disposed mid-update; ignore.
    }
  }, [themeId, transparent, themeOverridesKey]);

  if (error) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ef4444',
          fontSize: 13,
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        Terminal error: {error}
      </div>
    );
  }

  if (exited) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#64748b',
          fontSize: 13,
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        Session ended
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        width: '100%',
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        background: transparent ? 'transparent' : 'var(--t-terminal-bg, #16191e)',
        borderRadius: 0,
        overflow: 'hidden',
      }}
    >
      {inlineImages.map((image) => (
        <div
          key={image.id}
          style={{
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
            borderBottom: '1px solid var(--t-divider)',
            flexShrink: 0,
          }}
        >
          <img
            src={image.dataUrl}
            alt={image.filename}
            style={{
              maxWidth: '100%',
              maxHeight: 400,
              borderRadius: 8,
              objectFit: 'contain',
            }}
          />
          <div
            style={{
              fontSize: 11,
              color: 'var(--t-text-muted)',
              marginTop: 4,
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            {image.filename}
          </div>
        </div>
      ))}
      <div
        ref={containerRef}
        className="cortex-terminal-fade"
        style={{
          // minHeight:0 lets this flex child shrink below the xterm's intrinsic
          // content height. Without it the terminal keeps its full row-count
          // height and the parent's overflow:hidden clips the bottom rows (the
          // "cut off" trust prompt in the canvas terminal card). With it, the
          // ResizeObserver re-fits to the actual visible height — which also
          // fixes the spawn glyph centering, since spawn-reveal centers on
          // term.rows and stale (too-many) rows pushed the glyph below center.
          flex: 1,
          minHeight: 0,
          width: '100%',
          overflow: 'hidden',
          background: transparent ? 'transparent' : 'var(--t-terminal-bg, #16191e)',
          paddingTop: 2,
          paddingLeft: 2,
        }}
      />
    </div>
  );
});
