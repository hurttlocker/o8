export interface InlineImage {
  id: string;
  dataUrl: string;
  filename: string;
}

export interface XtermPanelProps {
  tmuxSession: string;
  /** Observe an existing run without writing keystrokes into its PTY. */
  readOnly?: boolean;
  inputLocked?: boolean;
  /** Enable readable terminal output for setup and other assistive surfaces. */
  screenReaderMode?: boolean;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number, readOnly?: boolean) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalVisibility?: (sessionName: string, visible: boolean, options?: { epoch?: number; needsResync?: boolean; cols?: number; rows?: number }) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
  /** Render with no background so the host surface (canvas glass) reads
   *  through. The host owns legibility (its own tint/veil behind the text). */
  transparent?: boolean;
  /** Override the terminal font size (default 13). */
  fontSize?: number;
  /** Override the line-height multiplier (default 1.45). The canvas passes 1.0
   *  so xterm's DOM-renderer selection overlay aligns with the glyph baseline —
   *  a taller line offsets the highlight ~½ line up from the text under CSS zoom (#1245). */
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
  setSourceDimensions?: (cols: number, rows: number) => void;
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
