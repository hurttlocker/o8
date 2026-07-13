'use client';

/**
 * BottomXtermPanel — the xterm.js surface used by the bottom ContextualPanel
 * for each terminal tab. Extracted from ContextualPanel.tsx to keep that file
 * under the 800-line ceiling. Mirrors the TerminalWorkspace xterm pattern:
 * lazy-loads @xterm/* on mount, attaches to a tmux session over WS, and renders
 * any inline images the agent emits.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme/context';
import { buildXtermTheme } from '@/components/desktop/workspace-terminal/constants';
import { registerXtermSelectionSource } from '@/components/desktop/workspace-terminal/xterm-selection-registry';

interface InlineImage {
  id: string;
  dataUrl: string;
  filename: string;
}

export interface XtermPanelHandle {
  writeData: (data: string) => void;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: () => void;
}

export const BottomXtermPanel = forwardRef<XtermPanelHandle, {
  tmuxSession: string;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
  /** Watch-only: render live output but never forward keystrokes to the PTY. */
  readOnly?: boolean;
}>(function BottomXtermPanel(
  { tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, visible, readOnly = false },
  ref,
) {
  const { themeId } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fitAddonRef = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const imageCountRef = useRef(0);

  useImperativeHandle(ref, () => ({
    writeData: (data: string) => {
      if (!termRef.current) return;
      try {
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        termRef.current.write(bytes);
      } catch { /* ignore decode errors */ }
    },
    showImage: (imageB64: string, filename: string) => {
      const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
      const dataUrl = `data:${mime};base64,${imageB64}`;
      imageCountRef.current += 1;
      setInlineImages(prev => [...prev, { id: `img-${imageCountRef.current}`, dataUrl, filename }]);
      if (termRef.current) termRef.current.write('\r\n\r\n');
    },
    setError: (err: string) => setError(err),
    setExited: () => setExited(true),
  }), []);

  useEffect(() => {
    if (!visible || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
        // Pin to the latest output. While the panel is hidden (display:none)
        // the buffer keeps growing but the viewport doesn't track the bottom,
        // so on re-show it lands mid-scroll. A second deferred call catches
        // any tmux replay that streams in just after the fit.
        termRef.current?.scrollToBottom();
        setTimeout(() => termRef.current?.scrollToBottom(), 200);
      } catch { /* ignore */ }
    }, 50);
    return () => clearTimeout(timer);
  }, [visible, sendTerminalResize, tmuxSession]);

  useEffect(() => {
    if (!containerRef.current) return;
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
          fontSize: 12,
          lineHeight: 1.35,
          cursorBlink: true,
          cursorStyle: 'block',
          // Opaque canvas — blending against the chrome would make the
          // terminal bleed through the glass on midnight / dark themes.
          allowTransparency: false,
          allowProposedApi: true,
          scrollback: 10000,
          // Watch posture: a read-only agent-run view never captures input.
          disableStdin: readOnly,
          theme: buildXtermTheme(),
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

        if (!containerRef.current || disposed) { term.dispose(); return; }

        term.open(containerRef.current);
        fitAddon.fit();
        termRef.current = term;
        fitAddonRef.current = fitAddon;

        sendTerminalAttach(tmuxSession, term.cols, term.rows);
        // Read-only (agent-run) views watch without typing into the agent's PTY.
        if (!readOnly) {
          term.onData((data) => { sendTerminalInput(tmuxSession, data); });
        }

        const observer = new ResizeObserver(() => {
          if (disposed || !fitAddonRef.current) return;
          try {
            fitAddonRef.current.fit();
            sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          } catch { /* ignore */ }
        });
        if (containerRef.current) observer.observe(containerRef.current);

        return () => { observer.disconnect(); };
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : 'Failed to load terminal');
      }
    }

    const cleanupPromise = init();

    // Speak-selection bridge (Ctrl+Shift+R) — xterm selections aren't DOM
    // selections; register a getter so the dashboard handler can read them.
    const unregisterSelection = registerXtermSelectionSource(
      () => termRef.current?.getSelection?.() ?? '',
    );

    return () => {
      disposed = true;
      unregisterSelection();
      sendTerminalDetach(tmuxSession);
      cleanupPromise?.then(cleanup => cleanup?.());
      if (termRef.current) { termRef.current.dispose(); termRef.current = null; }
      fitAddonRef.current = null;
    };
  }, [tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, readOnly]);

  // Live-update xterm theme when the app theme switches — no dispose/recreate.
  useEffect(() => {
    if (!termRef.current) return;
    try {
      termRef.current.options.theme = buildXtermTheme();
    } catch {
      // Terminal may have been disposed mid-update; safe to ignore.
    }
  }, [themeId]);

  if (error) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#ef4444', fontSize: 13, fontFamily: 'ui-monospace, monospace',
      }}>
        Terminal error: {error}
      </div>
    );
  }

  if (exited) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#64748b', fontSize: 13, fontFamily: 'ui-monospace, monospace',
      }}>
        Session ended
      </div>
    );
  }

  return (
    <div style={{
      flex: 1,
      width: '100%',
      display: visible ? 'flex' : 'none',
      flexDirection: 'column',
      background: 'var(--t-terminal-bg, #16191e)',
      overflow: 'hidden',
    }}>
      {inlineImages.map((img) => (
        <div key={img.id} style={{
          paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12,
          borderBottom: '1px solid var(--t-divider)', flexShrink: 0,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.dataUrl} alt={img.filename} style={{
            maxWidth: '100%', maxHeight: 400, borderRadius: 8, objectFit: 'contain',
          }} />
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>
            {img.filename}
          </div>
        </div>
      ))}
      <div ref={containerRef} className="cortex-terminal-fade" style={{
        // minHeight:0 lets this flex child shrink below the xterm's intrinsic
        // content height. Without it the terminal keeps its full row-count
        // height and the parent's overflow:hidden clips the bottom rows (the
        // "cut off" trust prompt). With it, the ResizeObserver re-fits the
        // xterm to the actual visible height so nothing is clipped.
        flex: 1, minHeight: 0, width: '100%', overflow: 'hidden', background: 'var(--t-terminal-bg, #16191e)', paddingTop: 2, paddingLeft: 2,
      }} />
    </div>
  );
});
