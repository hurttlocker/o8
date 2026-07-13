/**
 * xterm selection bridge for speak-selection (Ctrl+Shift+R).
 *
 * xterm.js selections are NOT DOM selections — `window.getSelection()` sees
 * nothing when the operator drag-selects inside a terminal tab, so the
 * dashboard's `o8:speak-selection` handler could never read terminal text
 * (live-hit 2026-07-13: the read chord was dead inside Claude Code terminal
 * tabs). Every mounted xterm registers a selection source here; the handler
 * falls back to the first non-empty terminal selection when the DOM has none.
 *
 * Note on Claude Code tabs specifically: when the TUI enables mouse reporting,
 * plain drag goes to the app — hold Shift while dragging to make an xterm
 * selection (xterm.js's standard override).
 */

type SelectionSource = () => string;

const sources = new Set<SelectionSource>();

/** Busy TUIs (Claude Code's spinner redraws) can wipe an xterm selection
 *  between the operator's drag and the chord press. Terminals report every
 *  selection change here, and the reader falls back to a recent snapshot so
 *  "highlight, then press Ctrl+Shift+R a beat later" still reads. */
const RECENT_SELECTION_TTL_MS = 10_000;
let recentSelection: { text: string; at: number } | null = null;

export function recordXtermSelectionSnapshot(text: string): void {
  if (text && text.trim()) {
    recentSelection = { text, at: Date.now() };
  }
}

/** Register a mounted terminal's selection getter. Returns an unregister fn. */
export function registerXtermSelectionSource(source: SelectionSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** First non-empty selection across all live terminals; falls back to a
 *  recent (≤10s) selection snapshot; '' when neither exists. */
export function readAnyXtermSelection(): string {
  for (const source of sources) {
    try {
      const text = source();
      if (text && text.trim()) return text;
    } catch {
      // A disposed terminal's getter must never break the read path.
    }
  }
  if (recentSelection && Date.now() - recentSelection.at <= RECENT_SELECTION_TTL_MS) {
    return recentSelection.text;
  }
  return '';
}
