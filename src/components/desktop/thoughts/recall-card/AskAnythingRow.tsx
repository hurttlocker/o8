'use client';

/**
 * #915 sub-4 — ASK ANYTHING row of the Context Recall Card.
 *
 * Inline chat input + Brain/Memory mode picker + streaming answer area.
 * Wires to `/api/cortex/ask` which is mocked in this scaffold (X-Mock: true)
 * and replaced in #915 sub-2 (Wave B) with the real BM25 + structured
 * retrievers + LLM compose path.
 *
 * Rules (CLAUDE.md):
 *   - Inline styles only — no CSS classes.
 *   - No CSS shorthand.
 *   - Phosphor icon as raw SVG.
 *   - Theme-token chrome — no hardcoded rgba surface fills.
 *   - The Brain/Memory toggle is *display-only* in this scaffold; real
 *     selection is auto-classified server-side.
 */

import { useCallback, useRef, useState } from 'react';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import { AnswerStream, type ContradictionNote } from './AnswerStream';
import type { Citation, CitationKind } from './CitationPill';
import {
  Chevron,
  expandedSurfaceStyle,
  FONT_FAMILY,
  rowChromeStyle,
  rowLabelStyle,
} from './shared';

type Mode = 'brain' | 'memory';

interface AskAnythingRowProps {
  open: boolean;
  onToggle: () => void;
  repoPath: string | null;
}

interface SseEvent {
  name: string;
  data: unknown;
}

function parseSseFrames(buffer: string): { frames: SseEvent[]; rest: string } {
  // SSE frames are separated by blank lines. Anything trailing without a
  // terminator stays in `rest` until the next chunk arrives.
  const frames: SseEvent[] = [];
  const segments = buffer.split('\n\n');
  const rest = segments.pop() ?? '';
  for (const segment of segments) {
    const lines = segment.split('\n');
    let name = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        name = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    frames.push({ name, data });
  }
  return { frames, rest };
}

function isCitationKind(value: unknown): value is CitationKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CITATION_KINDS, value);
}

const CITATION_KINDS: Record<CitationKind, true> = {
  directive: true,
  outcome: true,
  pr: true,
  issue: true,
  comment: true,
  doc: true,
  fact: true,
  symbol: true,
  project: true,
  project_repo: true,
};

function coerceCitation(payload: unknown): Citation | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (!isCitationKind(obj.kind)) return null;
  if (typeof obj.rowId !== 'string' || !obj.rowId) return null;
  const excerpt = typeof obj.excerpt === 'string' ? obj.excerpt : '';
  const url = typeof obj.url === 'string' ? obj.url : null;
  return { kind: obj.kind, rowId: obj.rowId, excerpt, url };
}

function coerceContradiction(payload: unknown): ContradictionNote | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.directiveId !== 'string' || typeof obj.outcomeId !== 'string') return null;
  if (typeof obj.summary !== 'string') return null;
  return {
    directiveId: obj.directiveId,
    outcomeId: obj.outcomeId,
    summary: obj.summary,
  };
}

export function AskAnythingRow({ open, onToggle, repoPath }: AskAnythingRowProps) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<Mode>('brain');
  const [tokens, setTokens] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [contradiction, setContradiction] = useState<ContradictionNote | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alert, setAlert] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || streaming) return;

    // Reset answer state on each fresh ask.
    setTokens('');
    setCitations([]);
    setContradiction(null);
    setError(null);
    setAlert(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetchWithLongLivedBudget('/api/cortex/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, repoPath, mode }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const msg = `HTTP ${res.status}`;
        setError(msg);
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
          if (frame.name === 'token') {
            const text =
              typeof frame.data === 'object' && frame.data !== null
                ? String((frame.data as Record<string, unknown>).text ?? '')
                : '';
            if (text) setTokens((prev) => prev + text);
          } else if (frame.name === 'citation') {
            const c = coerceCitation(frame.data);
            if (c) setCitations((prev) => [...prev, c]);
          } else if (frame.name === 'contradiction') {
            const note = coerceContradiction(frame.data);
            if (note) setContradiction(note);
          } else if (frame.name === 'done') {
            // No-op — the reader loop will exit on its own once the
            // server closes the stream.
          } else if (frame.name === 'error') {
            const message =
              typeof frame.data === 'object' && frame.data !== null
                ? String((frame.data as Record<string, unknown>).message ?? 'stream error')
                : 'stream error';
            setError(message);
          } else if (frame.name === 'alert') {
            const message = typeof frame.data === 'object' && frame.data !== null
              ? String((frame.data as Record<string, unknown>).message ?? '')
              : '';
            if (message) setAlert(message);
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }, [question, repoPath, mode, streaming]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const collapsedHint = streaming
    ? 'Asking the Brain…'
    : tokens || error
      ? 'Tap to expand answer'
      : 'Ask why we did anything — directive, outcome, PR';

  return (
    <div
      data-packet-row
      style={{
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          ...rowChromeStyle,
          background: open ? 'var(--t-divider-subtle)' : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = 'var(--t-divider-subtle)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={rowLabelStyle}>ask anything</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11.5,
            color: 'var(--t-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.005em',
          }}
        >
          {collapsedHint}
        </span>
        <Chevron open={open} />
      </button>

      {open ? (
        <div
          style={{
            ...expandedSurfaceStyle,
            paddingTop: 8,
            paddingBottom: 10,
            gap: 8,
          }}
        >
          <ComposerRow
            question={question}
            onChange={setQuestion}
            onKeyDown={onKeyDown}
            onSubmit={() => void submit()}
            onCancel={cancel}
            streaming={streaming}
            mode={mode}
            onModeChange={setMode}
          />
          {error ? (
            <div
              style={{
                fontFamily: FONT_FAMILY,
                fontSize: 10.5,
                color: '#b91c1c',
                paddingTop: 2,
                paddingLeft: 0,
              }}
            >
              {error}
            </div>
          ) : null}
          {alert ? (
            <div
              role="alert"
              style={{
                fontFamily: FONT_FAMILY,
                fontSize: 10.5,
                color: 'var(--t-brand-orange)',
                paddingTop: 2,
                paddingLeft: 0,
              }}
            >
              {alert}
            </div>
          ) : null}
        </div>
      ) : null}

      {open && (tokens || streaming || contradiction) ? (
        <AnswerStream
          tokens={tokens}
          citations={citations}
          contradiction={contradiction}
          streaming={streaming}
        />
      ) : null}
    </div>
  );
}

// ── Composer ──────────────────────────────────────────────────────────

interface ComposerRowProps {
  question: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  streaming: boolean;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
}

function ComposerRow({
  question,
  onChange,
  onKeyDown,
  onSubmit,
  onCancel,
  streaming,
  mode,
  onModeChange,
}: ComposerRowProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 6,
        paddingRight: 8,
        paddingBottom: 6,
        paddingLeft: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        background: 'var(--t-input-bg, var(--t-panel))',
      }}
    >
      <ModeToggle mode={mode} onChange={onModeChange} />
      <input
        type="text"
        value={question}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask the Brain — why did we choose JWT?"
        spellCheck={false}
        autoComplete="off"
        style={{
          flex: 1,
          minWidth: 0,
          borderWidth: 0,
          background: 'transparent',
          outline: 'none',
          fontFamily: FONT_FAMILY,
          fontSize: 12,
          letterSpacing: '-0.005em',
          color: 'var(--t-text)',
          paddingTop: 4,
          paddingRight: 4,
          paddingBottom: 4,
          paddingLeft: 4,
        }}
      />
      {streaming ? (
        <CancelButton onClick={onCancel} />
      ) : (
        <SendButton disabled={!question.trim()} onClick={onSubmit} />
      )}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div
      title="Mode is auto-selected by question class — toggle is preview-only."
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        gap: 0,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <ModeChip
        active={mode === 'brain'}
        label="Brain"
        onClick={() => onChange('brain')}
      />
      <ModeChip
        active={mode === 'memory'}
        label="Memory"
        onClick={() => onChange('memory')}
      />
    </div>
  );
}

function ModeChip({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        paddingTop: 3,
        paddingRight: 8,
        paddingBottom: 3,
        paddingLeft: 8,
        borderWidth: 0,
        background: active ? 'var(--t-accent-soft, rgba(37,99,235,0.12))' : 'transparent',
        color: active ? 'var(--t-accent, #2563eb)' : 'var(--t-text-muted)',
        fontFamily: FONT_FAMILY,
        fontSize: 10,
        fontWeight: active ? 600 : 500,
        letterSpacing: '0.02em',
        cursor: 'pointer',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </button>
  );
}

function SendButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Send (Enter)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 8,
        borderWidth: 0,
        background: disabled ? 'transparent' : 'var(--t-accent, #2563eb)',
        color: disabled ? 'var(--t-text-faint)' : '#ffffff',
        cursor: disabled ? 'default' : 'pointer',
        flexShrink: 0,
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <PaperPlaneIcon />
    </button>
  );
}

function CancelButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Cancel"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        background: 'transparent',
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        flexShrink: 0,
        fontSize: 14,
        lineHeight: 1,
      }}
    >
      ×
    </button>
  );
}

// Phosphor `paper-plane-tilt` glyph, raw SVG (no React icon component).
function PaperPlaneIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M227.32,28.68a16,16,0,0,0-15.66-4.08l-.15,0L19.57,82.84a16,16,0,0,0-2.42,29.84l85.62,40.55,40.55,85.62A15.86,15.86,0,0,0,157.74,248q.69,0,1.38-.06a15.88,15.88,0,0,0,14-11.51l58.2-191.94c0-.05,0-.1,0-.15A16,16,0,0,0,227.32,28.68ZM157.83,231.85l-.05.14,0-.07-40.08-84.61,48-48a8,8,0,0,0-11.31-11.31l-48,48L21.74,96l-.07,0,.14,0L213.69,40Z" />
    </svg>
  );
}
