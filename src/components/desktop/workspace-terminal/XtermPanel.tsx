'use client';
/* eslint-disable @next/next/no-img-element -- terminal image previews intentionally use raw panel-served URLs */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme/context';
import { buildXtermTheme } from '@/components/desktop/workspace-terminal/constants';

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
}

export interface XtermPanelHandle {
  writeData: (data: string) => void;
  writeRaw: (data: string) => void;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: () => void;
}

export const XtermPanel = forwardRef<XtermPanelHandle, XtermPanelProps>(function XtermPanel(
  { tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach, visible },
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
      setInlineImages((previous) => [...previous, { id: `img-${imageCountRef.current}`, dataUrl, filename }]);
      if (termRef.current) {
        termRef.current.write('\r\n\r\n');
      }
    },
    writeRaw: (data: string) => {
      if (!termRef.current) return;
      try {
        const encoder = new TextEncoder();
        termRef.current.write(encoder.encode(data));
      } catch {
        return;
      }
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
          fontSize: 12,
          lineHeight: 1.35,
          cursorBlink: true,
          cursorStyle: 'block',
          allowTransparency: false,
          allowProposedApi: true,
          scrollback: 10000,
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

        if (!containerRef.current || disposed) {
          term.dispose();
          return;
        }

        term.open(containerRef.current);
        fitAddon.fit();
        termRef.current = term;
        fitAddonRef.current = fitAddon;
        sendTerminalAttach(tmuxSession, term.cols, term.rows);
        term.onData((data) => {
          sendTerminalInput(tmuxSession, data);
        });

        const observer = new ResizeObserver(() => {
          if (disposed || !fitAddonRef.current) return;
          try {
            fitAddonRef.current.fit();
            sendTerminalResize(tmuxSession, termRef.current.cols, termRef.current.rows);
          } catch {
            return;
          }
        });
        if (containerRef.current) observer.observe(containerRef.current);
        return () => {
          observer.disconnect();
        };
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Failed to load terminal');
        }
      }
      return undefined;
    }

    const cleanupPromise = init();

    return () => {
      disposed = true;
      sendTerminalDetach(tmuxSession);
      cleanupPromise?.then((cleanup) => cleanup?.());
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      fitAddonRef.current = null;
    };
  }, [tmuxSession, sendTerminalAttach, sendTerminalDetach, sendTerminalInput, sendTerminalResize]);

  // Live-update xterm theme on theme switch without recreating the terminal.
  // The canvas repaints next frame with the new palette, PTY state is preserved.
  useEffect(() => {
    if (!termRef.current) return;
    try {
      termRef.current.options.theme = buildXtermTheme();
    } catch {
      // xterm may throw if the terminal was disposed mid-update; ignore.
    }
  }, [themeId]);

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
        background: 'var(--t-terminal-bg, #16191e)',
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
        style={{
          flex: 1,
          width: '100%',
          background: 'var(--t-terminal-bg, #16191e)',
          paddingTop: 2,
          paddingLeft: 2,
        }}
      />
    </div>
  );
});
