'use client';

/**
 * DispatchPopover — the glass card summoned by Cmd+Shift+O (issues #730, #753, #763).
 *
 * Layout (600x280):
 *   ┌─────────────────────────────────────────────┐
 *   │ Dispatch a task          [drag handle]  [×] │  44px header
 *   ├─────────────────────────────────────────────┤
 *   │                                             │
 *   │  What do you want done?                     │  textarea body
 *   │                                             │
 *   ├─────────────────────────────────────────────┤
 *   │ [Codex] [Gemini] [openc.] · repo▾   Send ⌘↵│  48px footer
 *   └─────────────────────────────────────────────┘
 *
 * Header is the entire drag region (`data-tauri-drag-region`). After a drag
 * finishes we read the new physical position via Tauri's `onMoved` event and
 * persist it via `save_dispatch_popover_position` so the next summons honors
 * the saved spot. Esc closes without dispatching; ⌘+Enter dispatches.
 *
 * Dispatch is fire-and-forget: POST /api/orchestrator/create-mission with
 * { repoPath, runtime, issues: [{title, body}] } then close the window. The
 * orchestrator's WS lane events drive the awaiting-review notification on the
 * main window, not this popover. Subcomponents live in `DispatchPopoverParts.tsx`
 * to keep this file under the 800-line ceiling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { V1_DISPATCH_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  ContextEnginePill,
  DispatchBody,
  DispatchFooter,
  DispatchHeader,
  ErrorRow,
  type RepoEntry,
} from './DispatchPopoverParts';

type CodebaseMemoryStatus = 'unknown' | 'downloading' | 'ready' | 'error';

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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement | null>(null);
  const runtimeButtonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const repoButtonRef = useRef<HTMLButtonElement | null>(null);

  const [value, setValue] = useState('');
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<OrchestratorRuntime>('codex');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<CodebaseMemoryStatus>('unknown');

  const dispatchableRuntimes = useMemo<OrchestratorRuntime[]>(() => V1_DISPATCH_RUNTIMES, []);

  // Mount: load repos, focus textarea.
  useEffect(() => {
    let cancelled = false;
    void loadRepos().then((list) => {
      if (cancelled) return;
      setRepos(list);
      // Default to most-recently-opened repo (lastOpenedAt-sorted from loadRepos).
      if (list.length > 0) setRepoPath(list[0].localPath);
    });
    const focusId = window.setTimeout(() => textareaRef.current?.focus(), 30);
    return () => {
      cancelled = true;
      window.clearTimeout(focusId);
    };
  }, []);

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

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    if (!repoPath) {
      setError('No repo registered. Open one in the dashboard first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/orchestrator/create-mission', {
        method: 'POST',
        headers: bearerHeaders(),
        body: JSON.stringify({
          repoPath,
          runtime,
          issues: [
            {
              number: Date.now(),
              title: trimmed.slice(0, 120),
              body: trimmed,
              url: '',
            },
          ],
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
  }, [busy, repoPath, runtime, value]);

  const onTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘+Enter / Ctrl+Enter dispatches. Plain Enter inserts a newline (this is
    // a textarea, not a single-line input, so the user can write multi-line tasks).
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  };

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
      <DispatchHeader busy={busy} onClose={() => void closePopover()} />
      {memoryDownloading ? <ContextEnginePill /> : null}
      <DispatchBody
        textareaRef={textareaRef}
        value={value}
        busy={busy}
        onChange={setValue}
        onKeyDown={onTextareaKeyDown}
      />
      {error ? <ErrorRow message={error} /> : null}
      <DispatchFooter
        runtime={runtime}
        runtimes={dispatchableRuntimes}
        runtimeButtonsRef={runtimeButtonsRef}
        onRuntimeChange={setRuntime}
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
        canSend={Boolean(value.trim()) && Boolean(repoPath) && !busy}
        busy={busy}
        onSend={() => void submit()}
      />
    </div>
  );
}
