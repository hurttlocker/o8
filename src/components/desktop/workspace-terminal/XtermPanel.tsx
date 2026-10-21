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
import { decodeTerminalBase64 } from './terminal-base64';
import { disposeTerminalOutput, resetTerminalOutput, setTerminalInputDisabled, writeTerminalOutput } from './terminal-output-writer';
import { terminalExitState, type TerminalExitState } from '@/lib/terminal/exit-state';
import { TerminalErrorNotice, TerminalExitNotice } from './TerminalExitNotice';
import { retainTerminalExitBuffer } from './terminal-exit-buffer';
import type { InlineImage, XtermPanelHandle, XtermPanelProps } from './xterm-panel-types';
export type { InlineImage, XtermPanelHandle, XtermPanelProps } from './xterm-panel-types';
import {
  recordTerminalBenchDelivery,
  recordTerminalBenchDimensions,
  recordTerminalBenchEvent,
  recordTerminalBenchPaint,
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

type TerminalVisibilityOptions = {
  epoch?: number;
  needsResync?: boolean;
  cols?: number;
  rows?: number;
};

function sendBenchTerminalVisibility(
  sendTerminalVisibility: XtermPanelProps['sendTerminalVisibility'],
  sessionName: string,
  visible: boolean,
  options: TerminalVisibilityOptions,
  reason: 'effect' | 'init' | 'reconnect',
): void {
  recordTerminalBenchEvent('send-terminal-visibility', {
    sessionName,
    visible,
    epoch: options.epoch ?? null,
    needsResync: options.needsResync ?? false,
    cols: options.cols ?? null,
    rows: options.rows ?? null,
    reason,
  });
  sendTerminalVisibility?.(sessionName, visible, options);
}

export const XtermPanel = forwardRef<XtermPanelHandle, XtermPanelProps>(function XtermPanel(
  { tmuxSession, exitState, onNewShell, onClose, readOnly = false, inputLocked = false, screenReaderMode = false, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalVisibility, sendTerminalDetach, visible, transparent, fontSize, lineHeight, connectionEpoch, spawnReveal, revealMinPlay, themeOverrides },
  ref,
) {
  const { themeId } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  const exitBufferRef = useRef<ReturnType<typeof retainTerminalExitBuffer> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const initCountRef = useRef(0);
  const tmuxSessionRef = useRef(tmuxSession);
  tmuxSessionRef.current = tmuxSession;
  const inputLockedRef = useRef(inputLocked);
  inputLockedRef.current = inputLocked;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const transparentRef = useRef(transparent);
  transparentRef.current = transparent;
  const revealCancelRef = useRef<((resetTerm: boolean) => void) | null>(null);
  /** While true, incoming PTY chunks queue instead of painting (min-play). */
  const revealHoldRef = useRef(false);
  const pendingChunksRef = useRef<Array<{ data: string; historical: boolean }>>([]);
  const hiddenBufferRef = useRef(new ClientTerminalHiddenBuffer(256 * 1024));
  const hiddenNeedsResyncRef = useRef(false);
  const initialNeedsResyncRef = useRef(Boolean(sendTerminalVisibility));
  const visibilityEpochRef = useRef(1);
  const awaitingVisibilityRef = useRef(Boolean(sendTerminalVisibility && visible));
  const snapshotReplayEpochRef = useRef<number | null>(null);
  const snapshotReplayGenerationRef = useRef(0);
  const queuedInputRef = useRef<string[]>([]);
  const sourceDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);

  /** Real output is about to paint — kill the reveal, clean slate.
   *  Ref nulls BEFORE invoking so re-entrant calls (the cancel fires the
   *  reveal's hold-point, whose handler may cancel again) are no-ops. */
  const cancelReveal = useCallback((resetTerm: boolean) => {
    const cancel = revealCancelRef.current;
    if (!cancel) return;
    revealCancelRef.current = null;
    cancel(resetTerm);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const exitRef = useRef<TerminalExitState | undefined>(exitState);
  const [exited, setExited] = useState<TerminalExitState | undefined>(exitState);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const imageCountRef = useRef(0);

  const fitTerminal = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const term = termRef.current;
    if (!fitAddon || !term) return;
    let proposedDimensions = null;
    try {
      proposedDimensions = fitAddon.proposeDimensions?.() ?? null;
      if (!readOnly || !sourceDimensionsRef.current) fitAddon.fit();
      recordTerminalBenchEvent('xterm-fit', {
        sessionName: tmuxSession,
        initCount: initCountRef.current,
        source: 'resize',
        cols: term.cols,
        rows: term.rows,
        proposedDimensions,
      });
      recordTerminalBenchDimensions(tmuxSession, term.cols, term.rows);
      if (!readOnly && !exitRef.current) sendTerminalResize(tmuxSession, term.cols, term.rows);
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
  }, [readOnly, sendTerminalResize, tmuxSession]);

  const finishReveal = useCallback((epoch: number) => {
    if (epoch !== visibilityEpochRef.current || !visibleRef.current) return;
    awaitingVisibilityRef.current = false;
    const queuedInput = queuedInputRef.current;
    queuedInputRef.current = [];
    if (!readOnly && !exitRef.current) for (const data of queuedInput) sendTerminalInput(tmuxSession, data);
  }, [readOnly, sendTerminalInput, tmuxSession]);

  const finishRevealAfterPaint = useCallback((epoch: number) => {
    requestAnimationFrame(() => finishReveal(epoch));
  }, [finishReveal]);

  const queueHiddenBytes = useCallback((bytes: Uint8Array, historical = false) => {
    const result = hiddenBufferRef.current.append(bytes, historical);
    if (result.droppedBytes === 0 || hiddenNeedsResyncRef.current) return;
    hiddenNeedsResyncRef.current = true;
    recordTerminalDiagnostic({
      code: 'terminal_client_hidden_overflow',
      sessionName: tmuxSession,
      bytesDropped: result.droppedBytes,
      retainedBytes: result.retainedBytes,
    });
  }, [tmuxSession]);

  const flushHiddenBytes = useCallback((epoch: number, afterWrite?: () => void) => {
    if (epoch !== visibilityEpochRef.current || !visibleRef.current) return;
    const chunks = hiddenBufferRef.current.drainChunks();
    if (!termRef.current || chunks.length === 0) {
      afterWrite?.(); finishRevealAfterPaint(epoch);
      return;
    }
    chunks.forEach((chunk, index) => writeTerminalOutput(termRef.current, chunk.data, index === chunks.length - 1 ? () => {
      afterWrite?.(); finishRevealAfterPaint(epoch);
    } : undefined, chunk.historical));
  }, [finishRevealAfterPaint]);

  const finishExit = useCallback((exitCode?: number | null, onSnapshot?: (state: TerminalExitState) => void) => {
    if (exitRef.current) return;
    exitRef.current = terminalExitState(exitCode);
    queuedInputRef.current = [];
    cancelReveal(false);
    revealHoldRef.current = false;
    const term = termRef.current;
    if (term) setTerminalInputDisabled(term, true);
    for (const chunk of pendingChunksRef.current.splice(0)) if (term) writeTerminalOutput(term, decodeTerminalBase64(chunk.data), undefined, chunk.historical);
    const bytes = hiddenBufferRef.current.drain();
    if (bytes.byteLength && term) writeTerminalOutput(term, bytes);
    const finish = () => {
      const current = readTerminalText(term, TERMINAL_SCROLLBACK_LINES);
      const state = terminalExitState(exitCode, exitBufferRef.current?.read() ?? current);
      if (term && state.transcript !== current) { term.reset(); setTerminalInputDisabled(term, true); writeTerminalOutput(term, state.transcript.replace(/\n/g, '\r\n'), undefined, true); }
      exitRef.current = state;
      setError(null);
      setExited(state);
      onSnapshot?.(state);
    };
    if (term) writeTerminalOutput(term, '', finish); else finish();
  }, [cancelReveal]);

  useEffect(() => {
    if (exitState) finishExit(exitState.exitCode);
  }, [exitState, finishExit]);

  useImperativeHandle(ref, () => ({
    fit: fitTerminal,
    setSourceDimensions: (cols: number, rows: number) => {
      if (!readOnly || !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) return;
      sourceDimensionsRef.current = { cols, rows };
      try { termRef.current?.resize(cols, rows); } catch { /* disposed during attach */ }
    },
    focus: () => termRef.current?.focus(),
    writeData: (data: string, historical = false) => {
      if (!termRef.current) return;
      if (revealHoldRef.current) {
        // Min-play hold: queue the chunk; the reveal's hold-point flushes.
        pendingChunksRef.current.push({ data, historical });
        return;
      }
      cancelReveal(true);
      try {
        if (!terminalBenchEnabled()) {
          const bytes = decodeTerminalBase64(data);
          if (!visibleRef.current || awaitingVisibilityRef.current) {
            queueHiddenBytes(bytes, historical);
            return;
          }
          writeTerminalOutput(termRef.current, bytes, undefined, historical);
          return;
        }
        const decodeStartedAt = performance.now();
        const bytes = decodeTerminalBase64(data);
        const decodeMs = performance.now() - decodeStartedAt;
        const visibleAtWrite = visibleRef.current;
        const sessionNameAtWrite = tmuxSessionRef.current;
        recordTerminalBenchDelivery(sessionNameAtWrite, bytes);
        if (!visibleAtWrite || awaitingVisibilityRef.current) {
          queueHiddenBytes(bytes, historical);
          return;
        }
        const completionStartedAt = performance.now();
        const writeStartedAt = performance.now();
        writeTerminalOutput(termRef.current, bytes, () => {
          recordTerminalBenchWriteCompletion(
            sessionNameAtWrite,
            visibleAtWrite,
            performance.now() - completionStartedAt,
          );
        }, historical);
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
        writeTerminalOutput(termRef.current, '\r\n\r\n');
      }
    },
    writeRaw: (data: string) => {
      if (!termRef.current) return;
      cancelReveal(true);
      try {
        const encoder = new TextEncoder();
        writeTerminalOutput(termRef.current, encoder.encode(data));
      } catch {
        return;
      }
    },
    readText: (lines = 40) => {
      return readTerminalText(termRef.current, lines);
    },
    visibilityReady: (epoch: number) => {
      recordTerminalBenchEvent('visibility-ready', {
        sessionName: tmuxSession,
        epoch,
        currentEpoch: visibilityEpochRef.current,
        visible: visibleRef.current,
        hasTerminal: Boolean(termRef.current),
        needsResync: initialNeedsResyncRef.current || hiddenNeedsResyncRef.current,
      });
      if (initialNeedsResyncRef.current || hiddenNeedsResyncRef.current) return;
      flushHiddenBytes(epoch);
    },
    applyResync: (data: string, epoch: number) => {
      const currentEpoch = visibilityEpochRef.current;
      const outcome = epoch !== currentEpoch
        ? `dropped:epoch(${epoch}≠${currentEpoch})`
        : !visibleRef.current
          ? 'dropped:not-visible'
          : !termRef.current
            ? 'dropped:no-terminal'
            : 'applied';
      recordTerminalBenchEvent('apply-resync', {
        sessionName: tmuxSession,
        epoch,
        currentEpoch,
        visible: visibleRef.current,
        hasTerminal: Boolean(termRef.current),
        outcome,
      });
      if (outcome !== 'applied') return;
      hiddenBufferRef.current.clear();
      initialNeedsResyncRef.current = false;
      hiddenNeedsResyncRef.current = false;
      const term = termRef.current;
      const replayGeneration = ++snapshotReplayGenerationRef.current;
      try {
        // Disable xterm's protocol answers before it parses historical bytes.
        // An empty snapshot still gets a write callback, which orders this
        // barrier after any earlier replay already queued in xterm.
        snapshotReplayEpochRef.current = epoch;
        setTerminalInputDisabled(term, true);
        const bytes = decodeTerminalBase64(data);
        // A tmux snapshot is historical output. Replaying an old DA/DSR
        // query must not send xterm's answer into the live shell as input.
        // Bytes held behind the resync barrier can contain attach-time tmux
        // probes as well. Paint them before restoring protocol answers.
        resetTerminalOutput(term, bytes, () => {
          if (termRef.current !== term || snapshotReplayGenerationRef.current !== replayGeneration) return;
          const finishReplay = () => {
            if (termRef.current !== term || snapshotReplayGenerationRef.current !== replayGeneration) return;
            snapshotReplayEpochRef.current = null;
            setTerminalInputDisabled(term, readOnly || inputLockedRef.current || Boolean(exitRef.current));
          };
          if (epoch !== visibilityEpochRef.current || !visibleRef.current) {
            hiddenNeedsResyncRef.current = true;
            finishReplay();
            return;
          }
          flushHiddenBytes(epoch, finishReplay);
        });
      } catch {
        if (snapshotReplayGenerationRef.current === replayGeneration) {
          snapshotReplayEpochRef.current = null;
          setTerminalInputDisabled(term, readOnly || inputLockedRef.current || Boolean(exitRef.current));
        }
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
    setError: (nextError: string) => { if (!exitRef.current) setError(nextError); },
    setExited: finishExit,
  }), [cancelReveal, finishExit, fitTerminal, flushHiddenBytes, queueHiddenBytes, readOnly, tmuxSession]);

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
    if (termRef.current) setTerminalInputDisabled(termRef.current, readOnly || inputLocked || Boolean(exitRef.current) || snapshotReplayEpochRef.current !== null);
  }, [inputLocked, readOnly]);

  useEffect(() => {
    if (!sendTerminalVisibility || exitRef.current) return;
    const epoch = visibilityEpochRef.current + 1;
    visibilityEpochRef.current = epoch;
    awaitingVisibilityRef.current = visible;
    if (!visible) {
      if (snapshotReplayEpochRef.current !== null) hiddenNeedsResyncRef.current = true;
      sendBenchTerminalVisibility(sendTerminalVisibility, tmuxSession, false, { epoch }, 'effect');
      return;
    }
    const term = termRef.current;
    const needsResync = initialNeedsResyncRef.current || hiddenNeedsResyncRef.current;
    if (needsResync) {
      hiddenBufferRef.current.clear();
      try { term?.reset(); } catch { /* disposed during tab switch */ }
    }
    sendBenchTerminalVisibility(sendTerminalVisibility, tmuxSession, true, {
      epoch,
      needsResync,
      cols: readOnly ? undefined : term?.cols,
      rows: readOnly ? undefined : term?.rows,
    }, 'effect');
  }, [readOnly, sendTerminalVisibility, tmuxSession, visible]);

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
          fontSize: fontSize ?? 13,
          lineHeight: lineHeight ?? 1.45,
          cursorBlink: true,
          cursorStyle: 'block',
          disableStdin: readOnly || inputLockedRef.current || Boolean(exitRef.current),
          screenReaderMode,
          allowTransparency: true,
          allowProposedApi: true,
          scrollback: TERMINAL_SCROLLBACK_LINES,
          theme: {
            ...buildXtermTheme(),
            ...(transparentRef.current ? { background: 'rgba(0,0,0,0)' } : {}),
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
        exitBufferRef.current = retainTerminalExitBuffer(term);
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
            recordTerminalBenchPaint(tmuxSession, () => readTerminalText(term, 1000));
          })
          : null;
        term.onData((data) => {
          if (readOnly || inputLockedRef.current || exitRef.current) return;
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
          if (exitRef.current) {
            writeTerminalOutput(liveTerm, exitRef.current.transcript.replace(/\n/g, '\r\n'), undefined, true);
            return;
          }
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
                    const bytes = decodeTerminalBase64(chunk.data);
                    writeTerminalOutput(termRef.current, bytes, undefined, chunk.historical);
                  } catch {
                    // skip malformed chunk
                  }
                }
              },
            });
          }
          const needsInitialSnapshot = Boolean(sendTerminalVisibility);
          if (needsInitialSnapshot) {
            initialNeedsResyncRef.current = true;
            awaitingVisibilityRef.current = visibleRef.current;
          }
          sendTerminalAttach(tmuxSession, liveTerm.cols, liveTerm.rows, readOnly);
          sendBenchTerminalVisibility(sendTerminalVisibility, tmuxSession, visibleRef.current, {
            epoch: visibilityEpochRef.current,
            needsResync: visibleRef.current
              && (initialNeedsResyncRef.current || hiddenNeedsResyncRef.current),
            cols: readOnly ? undefined : liveTerm.cols,
            rows: readOnly ? undefined : liveTerm.rows,
          }, 'init');
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
        exitBufferRef.current?.dispose(); exitBufferRef.current = null;
        disposeTerminalOutput(termRef.current);
        termRef.current.dispose();
        termRef.current = null;
      }
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cancelReveal only touches refs
  }, [tmuxSession, readOnly, screenReaderMode, sendTerminalAttach, sendTerminalDetach, sendTerminalInput, sendTerminalVisibility, fitTerminal, fontSize, lineHeight, spawnReveal, revealMinPlay]);

  // Re-attach after a transport (re)connect. The init effect's attach is
  // dropped silently if the socket isn't open yet, and the server never
  // pushes attachments — so each connect epoch resets the buffer and
  // attaches again. The server replays scrollback into the clean buffer,
  // which makes a duplicate attach visually idempotent.
  useEffect(() => {
    if (connectionEpoch === undefined || connectionEpoch < 1 || exitRef.current) return;
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
      sendTerminalAttach(tmuxSession, term.cols, term.rows, readOnly);
      sendBenchTerminalVisibility(sendTerminalVisibility, tmuxSession, visibleRef.current, {
        epoch,
        needsResync: true,
        cols: readOnly ? undefined : term.cols,
        rows: readOnly ? undefined : term.rows,
      }, 'reconnect');
    } catch {
      // disposed mid-update; the next mount attaches fresh
    }

  }, [cancelReveal, connectionEpoch, readOnly, tmuxSession, sendTerminalAttach, sendTerminalVisibility]);

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
      {error && !exited ? <TerminalErrorNotice error={error} /> : null}
      {exited ? <TerminalExitNotice state={exited} onNewShell={onNewShell} onClose={onClose} /> : null}
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
          overflow: readOnly ? 'auto' : 'hidden',
          background: transparent ? 'transparent' : 'var(--t-terminal-bg, #16191e)',
          paddingTop: 2,
          paddingLeft: 2,
        }}
      />
    </div>
  );
});
