'use client';

/**
 * DispatchPopover — the glass card summoned by Cmd+Shift+O (issues #730, #753, #763).
 *
 * Swarm composer: one or more agent rows, each with its own task + runtime
 * (Codex / Gemini). All rows dispatch as a SINGLE mission with per-issue
 * runtime, so a user can split coding + thinking across a mixed swarm — add
 * 1, 2, or 5 agents and pick who codes with what.
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ Dispatch a swarm         [drag handle]  [×] │  44px header
 *   ├─────────────────────────────────────────────┤
 *   │ Agent 1            [Codex] [Gemini]      ×  │
 *   │  What do you want done?                     │  row
 *   │ Agent 2            [Codex] [Gemini]      ×  │
 *   │  …                                          │
 *   │ + Add agent                                 │
 *   ├─────────────────────────────────────────────┤
 *   │ 2 agents · 1 Codex · 1 Gemini   repo▾  Send │  48px footer
 *   └─────────────────────────────────────────────┘
 *
 * Header is the entire drag region (`data-tauri-drag-region`). After a drag
 * finishes we read the new physical position via Tauri's `onMoved` event and
 * persist it via `save_dispatch_popover_position` so the next summons honors
 * the saved spot. Esc closes without dispatching; ⌘+Enter dispatches.
 *
 * Dispatch is fire-and-forget: POST /api/orchestrator/create-mission with
 * { repoPath, runtime, issues: [{title, body, runtime}, …] } then close the
 * window. The orchestrator's WS lane events drive the awaiting-review
 * notification on the main window, not this popover. Subcomponents live in
 * `DispatchPopoverParts.tsx` to keep this file under the 800-line ceiling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { V1_DISPATCH_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  ContextEnginePill,
  DispatchFooter,
  DispatchHeader,
  ErrorRow,
  SwarmBody,
  type RepoEntry,
  type SwarmRow,
} from './DispatchPopoverParts';

type CodebaseMemoryStatus = 'unknown' | 'downloading' | 'ready' | 'error';

// Window grows with the swarm: 280px base (one row) + 116px per extra row,
// capped at 620 (taller missions scroll inside the rows container).
const POPOVER_BASE_HEIGHT = 280;
const POPOVER_ROW_DELTA = 116;
const POPOVER_MAX_HEIGHT = 620;

function readWsToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? '';
}

function bearerHeaders(): Record<string, string> {
  const token = readWsToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function loadRepos(): Promise<RepoEntry[]> {
  try {
    const res = await fetch('/api/panel/repos', { headers: bearerHeaders() });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    const repos: RepoEntry[] = Array.isArray(json?.repos) ? json.repos : [];
    // Most-recently-opened first so the default selection is the active repo.
    return [...repos].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
  } catch {
    return [];
  }
}

async function invokeTauri(
  command: string,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke(command, payload);
  } catch {
    return null;
  }
}

async function closePopover(): Promise<void> {
  const handled = await invokeTauri('close_dispatch_popover');
  if (handled !== null) return;
  if (typeof window !== 'undefined') window.close();
}

export default function DispatchPopover() {
  const firstTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const repoButtonRef = useRef<HTMLButtonElement | null>(null);
  // Monotonic row-id source. Lives in a ref so render stays pure (no Date.now()
  // / Math.random() in the render path — React Compiler purity rule).
  const nextRowIdRef = useRef(1);

  const [rows, setRows] = useState<SwarmRow[]>([{ id: 'agent-0', text: '', runtime: 'codex' }]);
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<CodebaseMemoryStatus>('unknown');

  const dispatchableRuntimes = useMemo<OrchestratorRuntime[]>(() => V1_DISPATCH_RUNTIMES, []);

  // Mount: load repos, focus the first row.
  useEffect(() => {
    let cancelled = false;
    void loadRepos().then((list) => {
      if (cancelled) return;
      setRepos(list);
      // Default to most-recently-opened repo (lastOpenedAt-sorted from loadRepos).
      if (list.length > 0) setRepoPath(list[0].localPath);
    });
    const focusId = window.setTimeout(() => firstTextareaRef.current?.focus(), 30);
    return () => {
      cancelled = true;
      window.clearTimeout(focusId);
    };
  }, []);

  // Grow / shrink the popover window to fit the swarm. Pure JS Tauri API —
  // works even though the window is created non-resizable.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
      try {
        const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
          import('@tauri-apps/api/window'),
          import('@tauri-apps/api/dpi'),
        ]);
        if (cancelled) return;
        const height = Math.min(
          POPOVER_MAX_HEIGHT,
          POPOVER_BASE_HEIGHT + (rows.length - 1) * POPOVER_ROW_DELTA,
        );
        await getCurrentWindow().setSize(new LogicalSize(600, height));
      } catch {
        // Non-Tauri / API unavailable — body scrolls instead.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rows.length]);

  // Listen for the codebase-memory-mcp download status emitted by the Tauri
  // sidecar on launch. Don't block dispatch — show an inline pill so the user
  // knows the context engine isn't available for this packet.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const handle = await listen<string>('codebase-memory:status', (event) => {
          const status = event.payload;
          if (status === 'downloading' || status === 'ready' || status === 'error') {
            setMemoryStatus(status);
          }
        });
        if (cancelled) {
          handle();
        } else {
          unlisten = handle;
        }
      } catch {
        // Listener not available — leave status as 'unknown'.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Drag-end persistence: subscribe to the window's onMoved event and save the
  // last position to ~/.o8/popover-state.json via the Rust command. Debounced
  // to once-per-200ms because Tauri emits onMoved for every pixel of drag.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let debounceId: number | null = null;
    void (async () => {
      if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const handle = await win.onMoved(({ payload }) => {
          if (debounceId !== null) window.clearTimeout(debounceId);
          debounceId = window.setTimeout(() => {
            void invokeTauri('save_dispatch_popover_position', { x: payload.x, y: payload.y });
          }, 200);
        });
        if (cancelled) {
          handle();
        } else {
          unlisten = handle;
        }
      } catch {
        // Window API not available in non-Tauri contexts — drag persistence is a no-op.
      }
    })();
    return () => {
      cancelled = true;
      if (debounceId !== null) window.clearTimeout(debounceId);
      if (unlisten) unlisten();
    };
  }, []);

  // Esc closes; we capture at window-level because the textarea sometimes
  // swallows the keydown depending on the Tauri webview's focus state.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void closePopover();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const updateRowText = useCallback((id: string, text: string) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, text } : row)));
  }, []);

  const updateRowRuntime = useCallback((id: string, nextRuntime: OrchestratorRuntime) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, runtime: nextRuntime } : row)));
  }, []);

  const addRow = useCallback(() => {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      const id = `agent-${nextRowIdRef.current}`;
      nextRowIdRef.current += 1;
      // New agents inherit the previous row's runtime — adding a second Codex
      // is one click; switching one row to Gemini is the mix.
      return [...prev, { id, text: '', runtime: last?.runtime ?? 'codex' }];
    });
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.id !== id)));
  }, []);

  const filledRows = useMemo(() => rows.filter((row) => row.text.trim()), [rows]);
  const canSend = filledRows.length > 0 && Boolean(repoPath) && !busy;

  const submit = useCallback(async () => {
    if (busy) return;
    const ready = rows.filter((row) => row.text.trim());
    if (ready.length === 0) return;
    if (!repoPath) {
      setError('No repo registered. Open one in the dashboard first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Inline issues: number ≥ 90001 + empty url marks them ad-hoc (see
      // isInlineIssue). A timestamp base keeps them unique within the mission.
      const base = Date.now();
      const issues = ready.map((row, index) => {
        const trimmed = row.text.trim();
        return {
          number: base + index,
          title: trimmed.slice(0, 120),
          body: trimmed,
          url: '',
          runtime: row.runtime,
        };
      });
      const res = await fetch('/api/orchestrator/create-mission', {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({
          repoPath,
          // Mission-level runtime = the first agent's; each issue carries its
          // own runtime so the swarm can mix Codex + Gemini per packet.
          runtime: issues[0]?.runtime ?? 'codex',
          issues,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        setError(`Dispatch failed: ${res.status} ${txt.slice(0, 80)}`);
        setBusy(false);
        return;
      }
      // Fire-and-forget: close immediately. The packet's awaiting_review
      // notification is driven by the main window's WS lane handler.
      await closePopover();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
      setBusy(false);
    }
  }, [busy, repoPath, rows]);

  const onRowKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘+Enter / Ctrl+Enter dispatches the whole swarm. Plain Enter inserts a
    // newline so tasks can be multi-line.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  }, [submit]);

  const selectedRepo = repos.find((r) => r.localPath === repoPath) ?? null;
  const memoryDownloading = memoryStatus === 'downloading';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--t-panel)',
        backdropFilter: 'blur(28px) saturate(170%)',
        WebkitBackdropFilter: 'blur(28px) saturate(170%)',
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        boxShadow: '0 28px 56px -16px rgba(0, 0, 0, 0.42), 0 8px 16px -4px rgba(0, 0, 0, 0.18)',
        color: 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
        overflow: 'hidden',
      }}
    >
      <DispatchHeader busy={busy} agentCount={rows.length} onClose={() => void closePopover()} />
      {memoryDownloading ? <ContextEnginePill /> : null}
      <SwarmBody
        rows={rows}
        runtimes={dispatchableRuntimes}
        busy={busy}
        firstTextareaRef={firstTextareaRef}
        onChangeText={updateRowText}
        onChangeRuntime={updateRowRuntime}
        onAddRow={addRow}
        onRemoveRow={removeRow}
        onKeyDown={onRowKeyDown}
      />
      {error ? <ErrorRow message={error} /> : null}
      <DispatchFooter
        rows={rows}
        repoButtonRef={repoButtonRef}
        repoPickerOpen={repoPickerOpen}
        onRepoPickerToggle={() => setRepoPickerOpen((o) => !o)}
        onRepoPickerClose={() => setRepoPickerOpen(false)}
        repos={repos}
        selectedRepo={selectedRepo}
        onRepoSelect={(localPath) => {
          setRepoPath(localPath);
          setRepoPickerOpen(false);
        }}
        sendButtonRef={sendButtonRef}
        canSend={canSend}
        busy={busy}
        onSend={() => void submit()}
      />
    </div>
  );
}
