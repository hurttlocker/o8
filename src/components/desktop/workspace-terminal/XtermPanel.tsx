'use client';
/* eslint-disable @next/next/no-img-element -- terminal image previews intentionally use raw panel-served URLs */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme/context';
import { buildXtermTheme } from '@/components/desktop/workspace-terminal/constants';
import { startSpawnReveal } from '@/components/desktop/workspace-terminal/spawn-reveal';
import { recordXtermSelectionSnapshot, registerXtermSelectionSource } from '@/components/desktop/workspace-terminal/xterm-selection-registry';
import { retainInlineTerminalImages, TERMINAL_SCROLLBACK_LINES } from '@/lib/terminal/client-retention';
import { ClientTerminalHiddenBuffer } from '@/components/desktop/workspace-terminal/terminal-hidden-buffer';
import { recordTerminalDiagnostic } from '@/components/desktop/workspace-terminal/terminal-diagnostics';
import {
  recordTerminalBenchDimensions,
  recordTerminalBenchEvent,
  recordTerminalBenchRender,
  recordTerminalBenchVisibility,
  recordTerminalBenchWrite,
  recordTerminalBenchWriteCompletion,
  registerTerminalBenchPanel,
  terminalBenchEnabled,
} from '@/components/desktop/workspace-terminal/terminal-bench-instrumentation';

function readTerminalText(term: { buffer?: { active?: { length?: number; getLine: (index: number) => { translateToString: (trimRight: boolean) => string } | undefined } } } | null, lines = 40): string {
  if (!term?.buffer?.active) return '';
  const active = term.buffer.active;
  const length = active.length ?? 0;
  const start = Math.max(0, length - Math.max(1, Math.floor(lines)));
  const out: string[] = [];
  for (let index = start; index < length; index += 1) {
    out.push(active.getLine(index)?.translateToString(true) ?? '');
  }
  return out.join('\n').replace(/\s+$/g, '');
}

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
  sendTerminalVisibility?: (sessionName: string, visible: boolean, options?: { epoch?: number; needsResync?: boolean; cols?: number; rows?: number }) => void;
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
  fit: () => void;
  focus: () => void;
  writeData: (data: string) => void;
  writeRaw: (data: string) => void;
  readText: (lines?: number) => string;
  visibilityReady?: (epoch: number) => void;
  applyResync?: (data: string, epoch: number, historyTruncated: boolean, source: 'tmux' | 'scrollback') => void;
  recordDiagnostic?: (diagnostic: Record<string, unknown>) => void;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: () => void;
}

export const XtermPanel = forwardRef<XtermPanelHandle, XtermPanelProps>(function XtermPanel(
  { tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalVisibility, sendTerminalDetach, visible, transparent, fontSize, lineHeight, connectionEpoch, spawnReveal, revealMinPlay, themeOverrides },
  ref,
) {
  const { themeId } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const initCountRef = useRef(0);
  const tmuxSessionRef = useRef(tmuxSession);
  tmuxSessionRef.current = tmuxSession;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const revealCancelRef = useRef<((resetTerm: boolean) => void) | null>(null);
  /** While true, incoming PTY chunks queue instead of painting (min-play). */
  const revealHoldRef = useRef(false);
  const pendingChunksRef = useRef<string[]>([]);
  const hiddenBufferRef = useRef(new ClientTerminalHiddenBuffer(256 * 1024));
  const hiddenNeedsResyncRef = useRef(false);
  const visibilityEpochRef = useRef(1);
  const awaitingVisibilityRef = useRef(Boolean(sendTerminalVisibility && visible));
  const queuedInputRef = useRef<string[]>([]);

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

  const fitTerminal = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const term = termRef.current;
    if (!fitAddon || !term) return;
    let proposedDimensions = null;
    try {
      proposedDimensions = fitAddon.proposeDimensions?.() ?? null;
      fitAddon.fit();
      recordTerminalBenchEvent('xterm-fit', {
        sessionName: tmuxSession,
        initCount: initCountRef.current,
        source: 'resize',
        cols: term.cols,
        rows: term.rows,
        proposedDimensions,
      });
      recordTerminalBenchDimensions(tmuxSession, term.cols, term.rows);
      sendTerminalResize(tmuxSession, term.cols, term.rows);
    } catch (error) {
      recordTerminalBenchEvent('xterm-fit', {
        sessionName: tmuxSession,
        initCount: initCountRef.current,
        source: 'resize',
        cols: term.cols,
        rows: term.rows,
        proposedDimensions,
        error: error instanceof Error ? error.message : String(error),
      });
      // The terminal may be disposed while a queued fit is running.
    }
  }, [sendTerminalResize, tmuxSession]);

  const finishReveal = useCallback((epoch: number) => {
    if (epoch !== visibilityEpochRef.current || !visibleRef.current) return;
    awaitingVisibilityRef.current = false;
    const queuedInput = queuedInputRef.current;
    queuedInputRef.current = [];
    for (const data of queuedInput) sendTerminalInput(tmuxSession, data);
  }, [sendTerminalInput, tmuxSession]);

  const finishRevealAfterPaint = useCallback((epoch: number) => {
    requestAnimationFrame(() => finishReveal(epoch));
  }, [finishReveal]);

  const queueHiddenBytes = useCallback((bytes: Uint8Array) => {
    const result = hiddenBufferRef.current.append(bytes);
    if (result.droppedBytes === 0 || hiddenNeedsResyncRef.current) return;
    hiddenNeedsResyncRef.current = true;
    recordTerminalDiagnostic({
      code: 'terminal_client_hidden_overflow',
      sessionName: tmuxSession,
      bytesDropped: result.droppedBytes,
      retainedBytes: result.retainedBytes,
    });
  }, [tmuxSession]);

  const flushHiddenBytes = useCallback((epoch: number) => {
    if (epoch !== visibilityEpochRef.current || !visibleRef.current) return;
    const bytes = hiddenBufferRef.current.drain();
    if (!termRef.current || bytes.byteLength === 0) {
      finishRevealAfterPaint(epoch);
      return;
    }
    termRef.current.write(bytes, () => finishRevealAfterPaint(epoch));
  }, [finishRevealAfterPaint]);

  useImperativeHandle(ref, () => ({
    fit: fitTerminal,
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
        if (!terminalBenchEnabled()) {
          const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
          if (!visibleRef.current || awaitingVisibilityRef.current) {
            queueHiddenBytes(bytes);
            return;
          }
          termRef.current.write(bytes);
          return;
        }
        const decodeStartedAt = performance.now();
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        const decodeMs = performance.now() - decodeStartedAt;
        const visibleAtWrite = visibleRef.current;
        const sessionNameAtWrite = tmuxSessionRef.current;
        if (!visibleAtWrite || awaitingVisibilityRef.current) {
          queueHiddenBytes(bytes);
          return;
        }
        const completionStartedAt = performance.now();
        const writeStartedAt = performance.now();
        termRef.current.write(bytes, () => {
          recordTerminalBenchWriteCompletion(
            sessionNameAtWrite,
            visibleAtWrite,
            performance.now() - completionStartedAt,
          );
        });
        recordTerminalBenchWrite(sessionNameAtWrite, visibleAtWrite, {
          encodedBytes: data.length,
          decodedBytes: bytes.byteLength,
          decodeMs,
          writeCallMs: performance.now() - writeStartedAt,
        });
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
      return readTerminalText(termRef.current, lines);
    },
    visibilityReady: (epoch: number) => {
      if (hiddenNeedsResyncRef.current) return;
      flushHiddenBytes(epoch);
    },
    applyResync: (data: string, epoch: number) => {
      if (epoch !== visibilityEpochRef.current || !visibleRef.current || !termRef.current) return;
      hiddenBufferRef.current.clear();
      hiddenNeedsResyncRef.current = false;
      try {
        termRef.current.reset();
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        if (bytes.byteLength === 0) {
          flushHiddenBytes(epoch);
        } else {
          termRef.current.write(bytes, () => flushHiddenBytes(epoch));
        }
      } catch {
        recordTerminalDiagnostic({ code: 'terminal_resync_failed', sessionName: tmuxSession });
      }
    },
    recordDiagnostic: (diagnostic: Record<string, unknown>) => {
      const code = diagnostic.code;
      if (
        code !== 'terminal_hidden_overflow'
        && code !== 'terminal_resync_failed'
        && code !== 'terminal_resync_unsettled'
      ) return;
      recordTerminalDiagnostic({
        code,
        sessionName: typeof diagnostic.sessionName === 'string' ? diagnostic.sessionName : tmuxSession,
        clientId: typeof diagnostic.clientId === 'string' ? diagnostic.clientId : undefined,
        bytesDropped: typeof diagnostic.bytesDropped === 'number' ? diagnostic.bytesDropped : undefined,
        lastGoodOffset: typeof diagnostic.lastGoodOffset === 'number' ? diagnostic.lastGoodOffset : undefined,
        reason: typeof diagnostic.reason === 'string' ? diagnostic.reason : undefined,
        waitedMs: typeof diagnostic.waitedMs === 'number' ? diagnostic.waitedMs : undefined,
      });
    },
    setError: (nextError: string) => setError(nextError),
    setExited: () => setExited(true),
  }), [fitTerminal, flushHiddenBytes, queueHiddenBytes, tmuxSession]);

  useEffect(() => (
    registerTerminalBenchPanel(
      tmuxSession,
      visibleRef.current,
      (lines) => readTerminalText(termRef.current, lines),
    ) ?? undefined
  ), [tmuxSession]);

  useEffect(() => {
    recordTerminalBenchVisibility(tmuxSession, visible);
  }, [tmuxSession, visible]);

  useEffect(() => {
    if (!sendTerminalVisibility) return;
    const epoch = visibilityEpochRef.current + 1;
    visibilityEpochRef.current = epoch;
    awaitingVisibilityRef.current = visible;
    if (!visible) return sendTerminalVisibility(tmuxSession, false, { epoch });
    const term = termRef.current;
    if (hiddenNeedsResyncRef.current) {
      hiddenBufferRef.current.clear();
      try { term?.reset(); } catch { /* disposed during tab switch */ }
    }
    sendTerminalVisibility(tmuxSession, true, {
      epoch,
      needsResync: hiddenNeedsResyncRef.current,
      cols: term?.cols,
      rows: term?.rows,
    });
  }, [sendTerminalVisibility, tmuxSession, visible]);

  useEffect(() => {
    if (visible) {
      const timer = setTimeout(fitTerminal, 50);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [fitTerminal, visible]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    let disposed = false;
    const initCount = initCountRef.current + 1;
    initCountRef.current = initCount;
    const importsStartedAt = performance.now();
    recordTerminalBenchEvent('xterm-init-start', { sessionName: tmuxSession, initCount });

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
        recordTerminalBenchEvent('xterm-imports-resolved', {
          sessionName: tmuxSession,
          initCount,
          ms: performance.now() - importsStartedAt,
        });
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
        recordTerminalBenchEvent('xterm-created', {
          sessionName: tmuxSession,
          initCount,
          cols: term.cols,
          rows: term.rows,
        });
        const renderDisposable = terminalBenchEnabled()
          ? term.onRender(({ start, end }: { start: number; end: number }) => {
            recordTerminalBenchRender(tmuxSession, visibleRef.current, start, end);
          })
          : null;
        term.onData((data) => {
          if (awaitingVisibilityRef.current) {
            queuedInputRef.current.push(data);
            return;
          }
          sendTerminalInput(tmuxSession, data);
        });
        // Snapshot every selection for the speak-selection reader — busy TUIs
        // redraw and can wipe the live selection before the chord lands.
        term.onSelectionChange(() => {
          recordXtermSelectionSnapshot(term.getSelection?.() ?? '');
        });

        observerRef.current = new ResizeObserver(() => {
          if (disposed || !visibleRef.current) return;
          fitTerminal();
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
          let proposedDimensions = null;
          let fitError = null;
          try {
            proposedDimensions = fitAddonRef.current.proposeDimensions?.() ?? null;
            fitAddonRef.current.fit();
          } catch (error) {
            fitError = error instanceof Error ? error.message : String(error);
          }
          recordTerminalBenchEvent('xterm-fit', {
            sessionName: tmuxSession,
            initCount,
            source: 'initial',
            cols: liveTerm.cols,
            rows: liveTerm.rows,
            proposedDimensions,
            ...(fitError ? { error: fitError } : {}),
          });
          recordTerminalBenchDimensions(tmuxSession, liveTerm.cols, liveTerm.rows);
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
          const needsInitialSnapshot = Boolean(sendTerminalVisibility && visibleRef.current);
          if (needsInitialSnapshot) {
            hiddenNeedsResyncRef.current = true;
            awaitingVisibilityRef.current = true;
          }
          sendTerminalAttach(tmuxSession, liveTerm.cols, liveTerm.rows);
          sendTerminalVisibility?.(tmuxSession, visibleRef.current, {
            epoch: visibilityEpochRef.current,
            needsResync: needsInitialSnapshot || hiddenNeedsResyncRef.current,
            cols: liveTerm.cols,
            rows: liveTerm.rows,
          });
        }));
        return () => {
          renderDisposable?.dispose();
          observerRef.current?.disconnect();
          observerRef.current = null;
        };
      } catch (err) {
        recordTerminalBenchEvent('xterm-init-error', {
          sessionName: tmuxSession,
          initCount,
          error: err instanceof Error ? err.message : String(err),
        });
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
      recordTerminalBenchEvent('xterm-disposed', {
        sessionName: tmuxSession,
        initCount,
        hadTerminal: Boolean(termRef.current),
      });
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
  }, [tmuxSession, sendTerminalAttach, sendTerminalDetach, sendTerminalInput, sendTerminalVisibility, fitTerminal, transparent, fontSize, lineHeight, spawnReveal, revealMinPlay]);

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
      const epoch = visibilityEpochRef.current + 1;
      visibilityEpochRef.current = epoch;
      awaitingVisibilityRef.current = visibleRef.current;
      hiddenNeedsResyncRef.current = true;
      hiddenBufferRef.current.clear();
      term.reset();
      sendTerminalAttach(tmuxSession, term.cols, term.rows);
      sendTerminalVisibility?.(tmuxSession, visibleRef.current, {
        epoch,
        needsResync: true,
        cols: term.cols,
        rows: term.rows,
      });
    } catch {
      // disposed mid-update; the next mount attaches fresh
    }

  }, [connectionEpoch, tmuxSession, sendTerminalAttach, sendTerminalVisibility]);

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
      data-o8-term-panel={tmuxSession}
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
