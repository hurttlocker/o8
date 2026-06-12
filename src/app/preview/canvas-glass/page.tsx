'use client';

/**
 * /preview/canvas-glass — the Canvas-mode material + motion test page (#1232).
 *
 * Purpose: nail the glass and the design language BEFORE the real shell
 * revamp. Anatomy (all mock — no backend, no dispatch):
 *
 *   - top dock        → the important header controls (NOT Symon — Symon
 *                       lives in the macOS dock above everything) + the
 *                       orchestrator-dock toggle
 *   - left spawn dock → spawn component cards: orchestrator packet,
 *                       browser, terminal, review/diff, o8.md notes
 *   - left/right edge → hover-reveal rails (sessions / activity)
 *   - bottom input    → the orchestrator composer for the scoped repo;
 *                       first contact ALWAYS happens here
 *   - right dock      → OPT-IN (gabriell_lab borrow): dock the
 *                       conversation after you've talked, or open it to
 *                       see every running orchestrator and switch lanes.
 *                       Fades into the canvas — no hard panel.
 *   - glass cards     → draggable component cards; drop an image anywhere
 *                       and it piles "in the back" (desktop-on-desktop)
 *
 * In the o8 app the window swaps to the operator's chosen native material
 * (set_canvas_material) and the page paints NOTHING behind the glass —
 * the real desktop reads through ("Liquid" = raw transparent, sharpest).
 * In a plain browser the diffusion backdrop stands in for the desktop.
 * Gated on the experimentalCanvas operator flag like every canvas surface.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CANVAS_GLASS_DEFAULTS,
  applyCanvasGlassSettings,
  readCanvasGlassSettings,
  readPersonalDefault,
  savePersonalDefault,
  writeCanvasGlassSettings,
  type CanvasGlassSettings,
} from '@/lib/canvas-mode/glass-settings';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { isTauri, onFileOpenRequest, setCanvasBackdropBlur, setCanvasMaterial, takePendingFileOpens } from '@/lib/tauri/bridge';
import { useDesktopWebSocket } from '@/components/desktop/hooks/useDesktopWebSocket';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { DEFAULT_ORCHESTRATOR_MODEL } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';
import { THINKING_EFFORTS, isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { CanvasCard } from './cards';
import { DiffusionBackdrop, DockGlyphButton, EdgeRail, SpawnGlyphButton } from './chrome';
import { OrchestratorDock } from './dock';
import { FileGlassCard, type FileCard } from './file-card';
import { ImageGlassCard, type ImageCard } from './image-card';
import { CenterStage, type Stage } from './stage';
import { TerminalGlassCard, type TermCard } from './terminal-card';
import { TunerPanel } from './tuner';
import { useCanvasOrchestrator } from './use-canvas-orchestrator';
import { FONT, IMG_MAX_SPAWN_EDGE, glass, type CardKind, type DockEntry, type MockCard, type NewDockEntry, type OrchestratorLane } from './ui';

/** Terminal glass veil — persisted while Q dials it in (dev tuner). */
const TERM_VEIL_KEY = 'o8:canvas-term-veil';
const TERM_VEIL_DEFAULT = 0.35;

function readTermVeil(): number {
  if (typeof window === 'undefined') return TERM_VEIL_DEFAULT;
  try {
    const raw = window.localStorage.getItem(TERM_VEIL_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseFloat(raw);
    return Number.isFinite(parsed) ? Math.min(0.85, Math.max(0, parsed)) : TERM_VEIL_DEFAULT;
  } catch {
    return TERM_VEIL_DEFAULT;
  }
}

interface RepoPickerRowData {
  name: string;
  path: string;
}

// Mirrors COMPOSER_MODEL_OPTIONS in thoughts/InputButtons.tsx (not exported).
const CANVAS_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];
const CANVAS_ORCA_MODEL_KEY = 'o8:canvas-orca-model';
const CANVAS_ORCA_EFFORT_KEY = 'o8:canvas-orca-effort';

export default function CanvasGlassPreviewPage() {
  const canvasEnabled = useExperimentalCanvasFlag();
  const [settings, setSettings] = useState<CanvasGlassSettings>(CANVAS_GLASS_DEFAULTS);
  const [cards, setCards] = useState<MockCard[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [leftRailOpen, setLeftRailOpen] = useState(false);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [composerValue, setComposerValue] = useState('');
  const [inTauri, setInTauri] = useState(false);
  const [stage] = useState<Stage>({ kind: 'idle' });
  const [dockOpen, setDockOpen] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [personalDefault, setPersonalDefault] = useState<CanvasGlassSettings | null>(null);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [composerMenu, setComposerMenu] = useState<'repo' | 'model' | 'effort' | null>(null);
  const [orcaModel, setOrcaModel] = useState(DEFAULT_ORCHESTRATOR_MODEL);
  const [orcaEffort, setOrcaEffort] = useState<ThinkingEffort>('adaptive');
  const [orcaBusy, setOrcaBusy] = useState(false);
  const [convos, setConvos] = useState<Record<string, DockEntry[]>>({});
  const [termCards, setTermCards] = useState<TermCard[]>([]);
  const [fileCards, setFileCards] = useState<FileCard[]>([]);
  const [imageCards, setImageCards] = useState<ImageCard[]>([]);
  const [termVeil, setTermVeil] = useState(TERM_VEIL_DEFAULT);
  const [termPickerOpen, setTermPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [repos, setRepos] = useState<RepoPickerRowData[] | null>(null);
  const nextIdRef = useRef(1);
  const entryIdRef = useRef(1);
  // Cleared on every send; the first sign of life (text or tool) per turn
  // resolves the pending "Thinking" row and opens the dock.
  const firstOutputRef = useRef(new Set<string>());
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const xtermHandlesRef = useRef(new Map<string, XtermPanelHandle>());
  const liveSessionsRef = useRef(new Set<string>());
  const cdSentRef = useRef(new Set<string>());
  const dataSeenRef = useRef(new Set<string>());
  // First spawn of the visit gets the full reveal (min-play); the rest
  // bail the instant the shell answers — speed stays the default.
  const firstSpawnRef = useRef(true);
  // Terminals + file cards share one z band (10–39, chrome at 40+) so
  // clicking ANY card brings it above every other card kind.
  const zPeakRef = useRef(9);

  // Real terminals ride the production WebSocket — same transport, tmux
  // sessions and XtermPanel as the dashboard tabs.
  const {
    connectionState,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
  } = useDesktopWebSocket(undefined, {
    onTerminalCreated: (sessionName, requestId) => {
      if (!requestId || !requestId.startsWith('cnv-term-')) return;
      liveSessionsRef.current.add(sessionName);
      setTermCards((previous) => previous.map((card) => (
        card.requestId === requestId ? { ...card, sessionName } : card
      )));
    },
    onTerminalData: (sessionName, data) => {
      xtermHandlesRef.current.get(sessionName)?.writeData(data);
      // First PTY byte = the shell is real — flip the title off the
      // summoning verb. One-shot per session, not per chunk.
      if (!dataSeenRef.current.has(sessionName)) {
        dataSeenRef.current.add(sessionName);
        setTermCards((previous) => previous.map((card) => (
          card.sessionName === sessionName && !card.live ? { ...card, live: true } : card
        )));
      }
    },
    onTerminalAttached: (sessionName) => {
      // cwd fallback: today's bundled ws-server ignores the create-payload
      // cwd, so steer the fresh shell on first attach. Once the server-side
      // cwd ships, the pty already starts there and this cd is a no-op.
      if (cdSentRef.current.has(sessionName)) return;
      const card = termCards.find((existing) => existing.sessionName === sessionName);
      if (!card?.cwd) return;
      cdSentRef.current.add(sessionName);
      const escaped = card.cwd.replace(/'/g, `'\\''`);
      sendTerminalInput(sessionName, `cd '${escaped}' && clear\n`);
    },
    onTerminalExited: (sessionName) => {
      liveSessionsRef.current.delete(sessionName);
      xtermHandlesRef.current.get(sessionName)?.setExited();
      setTermCards((previous) => previous.map((card) => (
        card.sessionName === sessionName ? { ...card, exited: true } : card
      )));
    },
    onTerminalError: (sessionName, error) => {
      xtermHandlesRef.current.get(sessionName)?.setError(error);
    },
  });

  useEffect(() => {
    const stored = readCanvasGlassSettings();
    setSettings(stored);
    applyCanvasGlassSettings(stored);
    setInTauri(isTauri());
    setPersonalDefault(readPersonalDefault());
    setTermVeil(readTermVeil());
    try {
      const storedModel = window.localStorage.getItem(CANVAS_ORCA_MODEL_KEY);
      if (storedModel && CANVAS_MODEL_OPTIONS.some((option) => option.value === storedModel)) setOrcaModel(storedModel);
      const storedEffort = window.localStorage.getItem(CANVAS_ORCA_EFFORT_KEY);
      if (isThinkingEffort(storedEffort)) setOrcaEffort(storedEffort);
    } catch {
      // defaults stand
    }
  }, []);

  // Repos load at mount — the composer is scoped to a repo from the first
  // keystroke, not from the first picker open. Default scope: o8, else first.
  useEffect(() => {
    let disposed = false;
    fetch('/api/panel/repos')
      .then((response) => (response.ok ? response.json() : { repos: [] }))
      .then((data: { repos?: Array<{ name?: string | null; localPath?: string | null }> }) => {
        if (disposed) return;
        const rows = Array.isArray(data?.repos)
          ? data.repos
            .filter((repo) => typeof repo?.localPath === 'string' && repo.localPath.length > 0)
            .map((repo) => ({
              name: repo.name && repo.name.length > 0 ? repo.name : (repo.localPath!.split('/').pop() ?? repo.localPath!),
              path: repo.localPath!,
            }))
          : [];
        setRepos(rows);
        setActiveRepoPath((current) => current ?? rows.find((row) => row.name === 'o8')?.path ?? rows[0]?.path ?? null);
      })
      .catch(() => {
        if (!disposed) setRepos([]);
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Terminal sends drop silently while the socket is down and the server
  // never re-attaches a client — each connect bumps the epoch so every
  // mounted XtermPanel resets + re-attaches (scrollback replays).
  const [wsEpoch, setWsEpoch] = useState(0);
  useEffect(() => {
    if (connectionState === 'connected') setWsEpoch((epoch) => epoch + 1);
  }, [connectionState]);

  // Background material + backdrop blur: apply the stored choices while
  // this page is up, restore the chrome on the way out. No-op in a browser.
  useEffect(() => {
    if (!canvasEnabled) return;
    const stored = readCanvasGlassSettings();
    void setCanvasMaterial(stored.material);
    void setCanvasBackdropBlur(stored.backdropFrost);
    const timers = timersRef.current;
    return () => {
      void setCanvasMaterial('default');
      void setCanvasBackdropBlur(0);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [canvasEnabled]);

  const updateSettings = useCallback((patch: Partial<CanvasGlassSettings>) => {
    // Material + backdrop blur are native, not CSS — swap the window live.
    if (patch.material) void setCanvasMaterial(patch.material);
    if (patch.backdropFrost !== undefined) void setCanvasBackdropBlur(patch.backdropFrost);
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      writeCanvasGlassSettings(next);
      return next;
    });
  }, []);

  const spawnCard = useCallback((kind: CardKind, title: string, meta: string, tone: MockCard['tone'], at?: { x: number; y: number }, src?: string) => {
    setCards((previous) => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      const column = previous.length % 3;
      const row = Math.floor(previous.length / 3) % 3;
      return [...previous, {
        id,
        kind,
        title,
        meta,
        tone,
        x: at ? at.x : 300 + column * 250 + (id % 5) * 8,
        y: at ? at.y : 150 + row * 130 + (id % 7) * 6,
        src,
      }];
    });
  }, []);

  const appendEntries = useCallback((lane: string, entries: NewDockEntry[]) => {
    setConvos((previous) => {
      const next: DockEntry[] = entries.map((entry) => {
        const id = entryIdRef.current;
        entryIdRef.current += 1;
        return { ...entry, id };
      });
      return { ...previous, [lane]: [...(previous[lane] ?? []).filter((e) => e.role !== 'followups'), ...next] };
    });
  }, []);

  const resolveStatus = useCallback((lane: string, text: string) => {
    setConvos((previous) => ({
      ...previous,
      [lane]: (previous[lane] ?? []).map((entry) => (
        entry.role === 'status' && entry.pending ? { ...entry, pending: false, text } : entry
      )),
    }));
  }, []);

  /** Real orchestrator deltas grow the last live text entry in place. */
  const appendAssistantDelta = useCallback((lane: string, delta: string) => {
    setConvos((previous) => {
      const entries = previous[lane] ?? [];
      const last = entries[entries.length - 1];
      if (last && last.role === 'text' && last.live) {
        const updated = [...entries];
        updated[updated.length - 1] = { ...last, text: last.text + delta };
        return { ...previous, [lane]: updated };
      }
      const id = entryIdRef.current;
      entryIdRef.current += 1;
      return { ...previous, [lane]: [...entries, { role: 'text', text: delta, live: true, id }] };
    });
  }, []);

  // The REAL orchestrator — same ws-server channel the OrchestratorTab
  // speaks, scoped to the composer's repo. Convos are keyed by repo path.
  const orca = useCanvasOrchestrator(activeRepoPath, {
    onOutput: (repo, text, thinking) => {
      if (thinking) return;
      if (!firstOutputRef.current.has(repo)) {
        firstOutputRef.current.add(repo);
        resolveStatus(repo, 'Working');
        setDockOpen(true);
      }
      appendAssistantDelta(repo, text);
    },
    onToolUse: (repo, name) => {
      if (!firstOutputRef.current.has(repo)) {
        firstOutputRef.current.add(repo);
        resolveStatus(repo, 'Working');
        setDockOpen(true);
      }
      appendEntries(repo, [{ role: 'status', text: name, pending: false, kind: 'tool' }]);
    },
    onStatus: (repo, status) => {
      setOrcaBusy(status === 'busy');
      if (status === 'dead') resolveStatus(repo, 'Session ended');
      else if (status === 'ready') resolveStatus(repo, 'Done');
    },
    onError: (repo, error) => {
      resolveStatus(repo, 'Failed');
      appendEntries(repo, [{ role: 'status', text: error.slice(0, 200), pending: false }]);
    },
  });

  const submit = useCallback(() => {
    const prompt = composerValue.trim();
    if (!prompt || !activeRepoPath || orcaBusy) return;
    firstOutputRef.current.delete(activeRepoPath);
    const threadId = orca.send(prompt, { model: orcaModel, thinkingEffort: orcaEffort });
    if (!threadId) {
      // Socket not up yet — keep the draft in the composer for the retry.
      appendEntries(activeRepoPath, [
        { role: 'user', text: prompt },
        { role: 'status', text: 'Not connected yet — try again in a second', pending: false },
      ]);
      setDockOpen(true);
      return;
    }
    appendEntries(activeRepoPath, [
      { role: 'user', text: prompt },
      { role: 'status', text: 'Thinking', pending: true },
    ]);
    setComposerValue('');
  }, [activeRepoPath, appendEntries, composerValue, orca, orcaBusy, orcaEffort, orcaModel]);

  const chooseModel = useCallback((value: string) => {
    setOrcaModel(value);
    setComposerMenu(null);
    try {
      window.localStorage.setItem(CANVAS_ORCA_MODEL_KEY, value);
    } catch {
      // non-critical
    }
  }, []);

  const chooseEffort = useCallback((value: ThinkingEffort) => {
    setOrcaEffort(value);
    setComposerMenu(null);
    try {
      window.localStorage.setItem(CANVAS_ORCA_EFFORT_KEY, value);
    } catch {
      // non-critical
    }
  }, []);

  const moveCard = useCallback((id: number, x: number, y: number) => {
    setCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  /** Spawn a REAL shell — production transport, canvas treatment. */
  const spawnTerminal = useCallback((cwd: string | null, cwdLabel: string | null) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    const requestId = `cnv-term-${id}-${Math.random().toString(36).slice(2, 8)}`;
    const revealHold = firstSpawnRef.current;
    firstSpawnRef.current = false;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const z = zPeakRef.current;
    setTermCards((previous) => [...previous, {
      id,
      requestId,
      sessionName: null,
      exited: false,
      live: false,
      revealHold,
      x: 240 + (previous.length % 3) * 120 + (id % 5) * 10,
      y: 110 + (previous.length % 3) * 80,
      w: 560,
      h: 300,
      z,
      cwd,
      cwdLabel,
    }]);
    sendTerminalCreate(120, 30, requestId, cwd ?? undefined);
  }, [sendTerminalCreate]);

  const moveTermCard = useCallback((id: number, x: number, y: number) => {
    setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeTermCard = useCallback((id: number, w: number, h: number) => {
    setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, []);

  /** Clicked card comes forward. Terminals + files + images share the
   *  10–39 band — above the mock cards (3), below the chrome (40+). */
  const focusCard = useCallback((kind: 'term' | 'file' | 'image', id: number) => {
    const current = kind === 'term'
      ? termCards.find((card) => card.id === id)
      : kind === 'file'
        ? fileCards.find((card) => card.id === id)
        : imageCards.find((card) => card.id === id);
    if (!current || current.z === zPeakRef.current) return;
    if (zPeakRef.current + 1 > 38) {
      // Renormalize the whole band, keeping order, with the target on top.
      const combined = [
        ...termCards.map((card) => ({ kind: 'term' as const, id: card.id, z: card.z })),
        ...fileCards.map((card) => ({ kind: 'file' as const, id: card.id, z: card.z })),
        ...imageCards.map((card) => ({ kind: 'image' as const, id: card.id, z: card.z })),
      ].sort((a, b) => a.z - b.z);
      const remap = new Map(combined.map((entry, index) => [`${entry.kind}:${entry.id}`, 10 + index]));
      const top = 10 + combined.length;
      setTermCards((previous) => previous.map((card) => ({ ...card, z: kind === 'term' && card.id === id ? top : remap.get(`term:${card.id}`) ?? card.z })));
      setFileCards((previous) => previous.map((card) => ({ ...card, z: kind === 'file' && card.id === id ? top : remap.get(`file:${card.id}`) ?? card.z })));
      setImageCards((previous) => previous.map((card) => ({ ...card, z: kind === 'image' && card.id === id ? top : remap.get(`image:${card.id}`) ?? card.z })));
      zPeakRef.current = top;
      return;
    }
    zPeakRef.current += 1;
    const z = zPeakRef.current;
    if (kind === 'term') {
      setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'file') {
      setFileCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else {
      setImageCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    }
  }, [fileCards, imageCards, termCards]);

  const focusTermCard = useCallback((id: number) => focusCard('term', id), [focusCard]);
  const focusFileCard = useCallback((id: number) => focusCard('file', id), [focusCard]);
  const focusImageCard = useCallback((id: number) => focusCard('image', id), [focusCard]);

  const changeTermVeil = useCallback((value: number) => {
    setTermVeil(value);
    try {
      window.localStorage.setItem(TERM_VEIL_KEY, String(value));
    } catch {
      // non-critical — the dialed value just won't survive reload
    }
  }, []);

  /** Open ANY file on the machine as a glass card — view, edit, ⌘S. */
  const spawnFileCard = useCallback((path: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const z = zPeakRef.current;
    setFileCards((previous) => [...previous, {
      id,
      path,
      name: path.split('/').pop() || path,
      x: 300 + (previous.length % 3) * 90 + (id % 5) * 8,
      y: 96 + (previous.length % 3) * 64,
      w: 620,
      h: 420,
      z,
    }]);
  }, []);

  const moveFileCard = useCallback((id: number, x: number, y: number) => {
    setFileCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeFileCard = useCallback((id: number, w: number, h: number) => {
    setFileCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, []);

  const closeFileCard = useCallback((id: number) => {
    setFileCards((previous) => previous.filter((card) => card.id !== id));
  }, []);

  // Finder "Open With → o8" / dock drop — drain the OS-handed paths into
  // file cards, both at mount (cold launch routed here by FileOpenBridge)
  // and live while the canvas is up.
  useEffect(() => {
    if (!canvasEnabled || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const drain = () => {
      void takePendingFileOpens().then((paths) => {
        if (disposed) return;
        paths.forEach((path) => spawnFileCard(path));
      });
    };
    drain();
    void onFileOpenRequest(() => drain()).then((dispose) => {
      if (disposed) dispose?.();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canvasEnabled, spawnFileCard]);

  /** Native macOS choose-file (server-side osascript, the browse-folder
   *  pattern) — no Tauri dialog plugin needed, works in dev-bridge too. */
  const openFilePicker = useCallback(() => {
    fetch('/api/panel/file-io', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pick' }),
    })
      .then((response) => response.json())
      .then((data: { path?: string | null }) => {
        if (typeof data?.path === 'string' && data.path) spawnFileCard(data.path);
      })
      .catch(() => {});
  }, [spawnFileCard]);

  /** The spawn-dock terminal button opens the cwd picker; rows spawn. */
  const toggleTermPicker = useCallback(() => {
    setTermPickerOpen((value) => !value);
  }, []);

  /** Close = exit the shell (kills the tmux session) + detach + drop the card. */
  const closeTerminal = useCallback((card: TermCard) => {
    if (card.sessionName && !card.exited) {
      sendTerminalInput(card.sessionName, 'exit\n');
      sendTerminalDetach(card.sessionName);
      liveSessionsRef.current.delete(card.sessionName);
      xtermHandlesRef.current.delete(card.sessionName);
    }
    setTermCards((previous) => previous.filter((existing) => existing.id !== card.id));
  }, [sendTerminalDetach, sendTerminalInput]);

  const registerXtermHandle = useCallback((sessionName: string, handle: XtermPanelHandle | null) => {
    if (handle) xtermHandlesRef.current.set(sessionName, handle);
    else xtermHandlesRef.current.delete(sessionName);
  }, []);

  // Leaving the canvas exits every live canvas shell — they are canvas
  // objects, not dashboard tabs; lingering tmux sessions would get adopted
  // by the dashboard's terminal restore.
  useEffect(() => {
    const sessions = liveSessionsRef.current;
    return () => {
      for (const sessionName of sessions) {
        sendTerminalInput(sessionName, 'exit\n');
        sendTerminalDetach(sessionName);
      }
      sessions.clear();
    };
  }, [sendTerminalDetach, sendTerminalInput]);

  /** Drop a photo anywhere — it surfaces reference-style: filename pill,
   *  bottom edge dissolving into the canvas, aspect-locked resize. */
  const spawnImageCard = useCallback((file: File, at: { x: number; y: number }) => {
    const src = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      const natW = probe.naturalWidth || 1;
      const natH = probe.naturalHeight || 1;
      const aspect = natW / natH;
      const w = natW >= natH ? IMG_MAX_SPAWN_EDGE : Math.round(IMG_MAX_SPAWN_EDGE * aspect);
      const h = Math.round(w / aspect);
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
      const z = zPeakRef.current;
      setImageCards((previous) => [...previous, {
        id,
        x: Math.max(8, at.x - w / 2),
        y: Math.max(48, at.y - h / 2),
        z,
        w,
        h,
        aspect,
        items: [{ src, name: file.name }],
      }]);
    };
    probe.onerror = () => URL.revokeObjectURL(src);
    probe.src = src;
  }, []);

  const moveImageCard = useCallback((id: number, x: number, y: number) => {
    setImageCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeImageCard = useCallback((id: number, w: number) => {
    setImageCards((previous) => previous.map((card) => (
      card.id === id ? { ...card, w, h: Math.round(w / card.aspect) } : card
    )));
  }, []);

  const closeImageCard = useCallback((id: number) => {
    setImageCards((previous) => {
      const target = previous.find((card) => card.id === id);
      target?.items.forEach((item) => URL.revokeObjectURL(item.src));
      return previous.filter((card) => card.id !== id);
    });
  }, []);

  /** Dropped onto another photo → the two collapse into a stack (deck). */
  const dropImageCard = useCallback((id: number, centerX: number, centerY: number) => {
    setImageCards((previous) => {
      const dragged = previous.find((card) => card.id === id);
      if (!dragged) return previous;
      const target = previous.find((card) => (
        card.id !== id
        && centerX >= card.x && centerX <= card.x + card.w
        && centerY >= card.y && centerY <= card.y + card.h
      ));
      if (!target) return previous;
      return previous
        .filter((card) => card.id !== id)
        .map((card) => (card.id === target.id ? { ...card, items: [...card.items, ...dragged.items] } : card));
    });
  }, []);

  /** Tap a stack → the deck spreads back out into separate photos. */
  const unstackImageCard = useCallback((id: number) => {
    setImageCards((previous) => {
      const stackCard = previous.find((card) => card.id === id);
      if (!stackCard || stackCard.items.length < 2) return previous;
      const spread: ImageCard[] = stackCard.items.slice(1).map((item, index) => {
        const spreadId = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return {
          id: spreadId,
          x: stackCard.x + 36 * (index + 1),
          y: stackCard.y + 26 * (index + 1),
          z: zPeakRef.current,
          w: stackCard.w,
          h: stackCard.h,
          aspect: stackCard.aspect,
          items: [item],
        };
      });
      return [
        ...previous.map((card) => (card.id === id ? { ...card, items: [stackCard.items[0]!] } : card)),
        ...spread,
      ];
    });
  }, []);

  const dropImages = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'));
    files.forEach((file, index) => {
      spawnImageCard(file, { x: event.clientX + index * 30, y: event.clientY + index * 24 });
    });
  }, [spawnImageCard]);

  /** Top-right search — first matching card on the canvas comes forward. */
  const runCanvasSearch = useCallback(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return;
    const matches = (value: string | null | undefined) => (value ?? '').toLowerCase().includes(query);
    const term = termCards.find((card) => matches(card.cwdLabel) || matches(card.sessionName));
    if (term) { focusCard('term', term.id); return; }
    const file = fileCards.find((card) => matches(card.name) || matches(card.path));
    if (file) { focusCard('file', file.id); return; }
    const image = imageCards.find((card) => card.items.some((item) => matches(item.name)));
    if (image) { focusCard('image', image.id); return; }
    const mock = cards.find((card) => matches(card.title));
    if (mock) setSelectedCardId(mock.id);
  }, [cards, fileCards, focusCard, imageCards, searchQuery, termCards]);

  if (!canvasEnabled) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0c10', fontFamily: FONT }}>
        <span style={{ fontSize: 13, fontWeight: 300, color: 'rgba(255,255,255,0.65)', letterSpacing: '-0.1px', textAlign: 'center', lineHeight: 1.6, maxWidth: 380 }}>
          Canvas mode is off.
          <br />
          Enable “Experimental: Canvas mode” in Settings → Operator Defaults to unlock this surface.
        </span>
      </div>
    );
  }

  const summoning = stage.kind === 'summoning';
  // The dock's switcher only lists lanes that are actually running (have a
  // conversation) — scoping a NEW repo happens from the composer chip.
  const runningLanes: OrchestratorLane[] = (repos ?? [])
    .filter((repo) => (convos[repo.path]?.length ?? 0) > 0)
    .map((repo) => ({
      id: repo.path,
      label: repo.name,
      repo: repo.name,
      tone: repo.path === activeRepoPath && orcaBusy ? 'working' : 'idle',
    }));
  const activeRepoName = repos?.find((repo) => repo.path === activeRepoPath)?.name ?? null;
  const activeConvo = convos[activeRepoPath ?? ''] ?? [];
  const hasTalked = Object.values(convos).some((entries) => entries.length > 0);

  return (
    <div
      onDragOver={(event) => { event.preventDefault(); }}
      onDrop={dropImages}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', fontFamily: FONT, background: inTauri ? 'transparent' : '#07090d', userSelect: 'none' }}
    >
      {/* In the app the desktop IS the backdrop (native material). The
          diffusion only stands in where there is no desktop to show. */}
      {inTauri ? null : <DiffusionBackdrop />}

      {/* Window-wide veil + the canvas dot grid — the continuous darkness
          control for the background itself, painted over the material. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--cnv-bg-veil)',
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.055) 1px, transparent 1.4px)',
          backgroundSize: '26px 26px',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />

      {/* ── Kivo stage — owns the canvas while it is empty ───────── */}
      <AnimatePresence mode="wait">
        {(cards.length === 0 && termCards.length === 0 && fileCards.length === 0 && imageCards.length === 0) || summoning ? (
          <CenterStage key={stage.kind} stage={stage} />
        ) : null}
      </AnimatePresence>

      {/* ── Component cards ──────────────────────────────────────── */}
      {cards.map((card) => (
        <CanvasCard key={card.id} card={card} selected={selectedCardId === card.id} onMove={moveCard} onSelect={setSelectedCardId} />
      ))}

      {/* ── Real terminals (production transport, canvas treatment) ── */}
      <AnimatePresence>
        {termCards.map((card) => (
          <TerminalGlassCard
            key={card.id}
            card={card}
            termVeil={termVeil}
            connectionEpoch={wsEpoch}
            onMove={moveTermCard}
            onResize={resizeTermCard}
            onFocus={focusTermCard}
            onClose={closeTerminal}
            onTermVeilChange={changeTermVeil}
            registerHandle={registerXtermHandle}
            sendTerminalAttach={sendTerminalAttach}
            sendTerminalInput={sendTerminalInput}
            sendTerminalResize={sendTerminalResize}
            sendTerminalDetach={sendTerminalDetach}
          />
        ))}
      </AnimatePresence>

      {/* ── File cards — any file on the machine, view/edit/save ──── */}
      <AnimatePresence>
        {fileCards.map((card) => (
          <FileGlassCard
            key={card.id}
            card={card}
            termVeil={termVeil}
            onMove={moveFileCard}
            onResize={resizeFileCard}
            onFocus={focusFileCard}
            onClose={closeFileCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Image cards — photos dissolve into the canvas; drag together
            to stack, tap a deck to spread ─────────────────────────── */}
      <AnimatePresence>
        {imageCards.map((card) => (
          <ImageGlassCard
            key={card.id}
            card={card}
            onMove={moveImageCard}
            onResize={resizeImageCard}
            onFocus={focusImageCard}
            onDrop={dropImageCard}
            onTap={unstackImageCard}
            onClose={closeImageCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Top dock — the important header controls ─────────────── */}
      <div
        style={{
          position: 'absolute',
          top: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 40,
          paddingLeft: 16,
          paddingRight: 10,
          borderRadius: 20,
          zIndex: 40,
          ...glass(true),
        }}
      >
        <span style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '0.02em' }}>o8</span>
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <button
          type="button"
          aria-label="Glass tuner"
          onClick={() => setTunerOpen((value) => !value)}
          style={{
            borderWidth: 0,
            background: 'transparent',
            padding: 0,
            fontSize: 11.5,
            fontWeight: tunerOpen ? 400 : 300,
            color: tunerOpen ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
            cursor: 'pointer',
            fontFamily: FONT,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { if (!tunerOpen) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          Canvas
        </button>
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <DockGlyphButton label="Agents" path="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" extra={<circle cx="9" cy="7" r="4" />} />
        <DockGlyphButton label="Alerts" path="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        <DockGlyphButton
          label="Orchestrators"
          active={dockOpen}
          onClick={() => setDockOpen((value) => !value)}
          path="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
          extra={<path d="M15 3v18" />}
        />
        <span style={{ width: 1, height: 16, background: 'var(--cnv-edge)' }} />
        <button
          type="button"
          onClick={() => {
            // Restore the chrome BEFORE the hard navigation — the unmount
            // cleanup is not guaranteed across location.assign.
            void Promise.allSettled([setCanvasMaterial('default'), setCanvasBackdropBlur(0)]).then(() => {
              window.location.assign('/dashboard');
            });
          }}
          style={{
            borderWidth: 0,
            background: 'transparent',
            padding: 0,
            paddingLeft: 4,
            paddingRight: 6,
            fontSize: 11,
            fontWeight: 300,
            color: 'var(--cnv-ink-muted)',
            cursor: 'pointer',
            fontFamily: FONT,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          Exit
        </button>
      </div>

      {/* ── Top-right — search + the operator (reference borrow) ──── */}
      <div
        style={{
          position: 'absolute',
          top: 18,
          right: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          paddingLeft: 6,
          paddingRight: 6,
          borderRadius: 20,
          zIndex: 41,
          ...glass(true),
        }}
      >
        <button
          type="button"
          aria-label="Search the canvas"
          onClick={() => setSearchOpen((value) => !value)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderWidth: 0,
            background: 'transparent',
            borderRadius: 14,
            color: searchOpen ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
            cursor: 'pointer',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { if (!searchOpen) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
        </button>
        <span
          aria-label="Operator"
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            border: '1px solid var(--cnv-edge)',
            background: 'var(--cnv-tint)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--cnv-ink-muted)',
            flexShrink: 0,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
        </span>
      </div>

      {/* Search popover — Enter brings the first matching card forward. */}
      <AnimatePresence>
        {searchOpen ? (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            style={{
              position: 'absolute',
              top: 64,
              right: 24,
              width: 240,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 36,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 18,
              zIndex: 41,
              ...glass(true),
            }}
          >
            <input
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') runCanvasSearch();
                if (event.key === 'Escape') setSearchOpen(false);
              }}
              placeholder="Find a card on the canvas"
              aria-label="Search the canvas"
              style={{
                flex: 1,
                borderWidth: 0,
                outline: 'none',
                background: 'transparent',
                color: 'var(--cnv-ink)',
                fontSize: 11.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                fontFamily: FONT,
              }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Left spawn dock — the component vocabulary ───────────── */}
      <div
        style={{
          position: 'absolute',
          left: 16,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 6,
          paddingRight: 6,
          borderRadius: 16,
          zIndex: 40,
          ...glass(true),
        }}
      >
        <SpawnGlyphButton label="Spawn orchestrator" onClick={() => spawnCard('packet', 'Orchestrator · o8', 'fleet · ready', 'idle')}>
          <circle cx="12" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M12 8v4M12 12l-6 4M12 12l6 4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn browser" onClick={() => spawnCard('browser', 'Browser', 'localhost:3001', 'idle')}>
          <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn terminal" onClick={toggleTermPicker}>
          <path d="m4 17 6-6-6-6" /><line x1="12" x2="20" y1="19" y2="19" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Open file" onClick={openFilePicker}>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn review" onClick={() => spawnCard('review', 'Review — pending diff', '2 files · +14 −3', 'waiting')}>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect width="8" height="4" x="8" y="2" rx="1" /><path d="m9 14 2 2 4-4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn o8.md notes" onClick={() => spawnCard('packet', 'o8.md · o8', 'workspace notes', 'idle')}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </SpawnGlyphButton>
      </div>

      {/* ── Terminal cwd picker — where should the shell open? ───── */}
      <AnimatePresence>
        {termPickerOpen ? (
          <>
            <div role="presentation" onClick={() => setTermPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, x: -8, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -8, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              style={{
                position: 'absolute',
                left: 64,
                top: '50%',
                transform: 'translateY(-50%)',
                width: 232,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 14,
                zIndex: 46,
                ...glass(true),
              }}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 5 }}>
                Open terminal in
              </span>
              <PickerRow
                name="Home"
                path="~"
                onClick={() => {
                  spawnTerminal(null, null);
                  setTermPickerOpen(false);
                }}
              />
              {(repos ?? []).map((repo) => (
                <PickerRow
                  key={repo.path}
                  name={repo.name}
                  path={repo.path.replace(/^\/Users\/[^/]+/, '~')}
                  onClick={() => {
                    spawnTerminal(repo.path, repo.name);
                    setTermPickerOpen(false);
                  }}
                />
              ))}
              {repos === null ? (
                <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingTop: 4 }}>
                  Loading repos…
                </span>
              ) : null}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* ── Edge hover rails ─────────────────────────────────────── */}
      <EdgeRail
        side="left"
        open={leftRailOpen}
        onOpenChange={setLeftRailOpen}
        title="Sessions"
        rows={[
          ['Quick round-trip check', 'orchestrator · 1h ago'],
          ['Polish group C', 'merged · 2h ago'],
          ['Fleet canvas v1', 'merged · 1h ago'],
        ]}
      />
      {dockOpen ? null : (
        <EdgeRail
          side="right"
          open={rightRailOpen}
          onOpenChange={setRightRailOpen}
          title="Activity"
          rows={[
            ['0.1.356 shipped', 'release · just now'],
            ['feat(canvas): background controls', 'main · 10m ago'],
            ['feat(canvas): v2 glass slice', 'main · 1h ago'],
          ]}
        />
      )}

      {/* ── The docked orchestrator (opt-in, gabriell_lab borrow) ── */}
      <AnimatePresence>
        {dockOpen ? (
          <OrchestratorDock
            lanes={runningLanes}
            entries={activeConvo}
            activeLane={activeRepoPath ?? ''}
            activeLabel={activeRepoName ?? '…'}
            activeTone={orcaBusy ? 'working' : 'idle'}
            onSelectLane={setActiveRepoPath}
            onClose={() => setDockOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      {/* Dock affordance — appears once you have talked, until docked. */}
      <AnimatePresence>
        {hasTalked && !dockOpen ? (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            onClick={() => setDockOpen(true)}
            style={{
              position: 'absolute',
              bottom: 86,
              right: 24,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 999,
              cursor: 'pointer',
              zIndex: 40,
              fontSize: 10.5,
              fontWeight: 300,
              color: 'var(--cnv-ink-muted)',
              fontFamily: FONT,
              ...glass(true),
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            Dock orchestrator
            <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M15 3v18" />
            </svg>
          </motion.button>
        ) : null}
      </AnimatePresence>

      {/* ── Bottom orchestrator input — first contact lives here ─── */}
      <div
        style={{
          position: 'absolute',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(680px, calc(100vw - 240px))',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 48,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 24,
          zIndex: 40,
          ...glass(true),
        }}
      >
        <ChipButton
          label={activeRepoName ?? '…'}
          active={composerMenu === 'repo'}
          onClick={() => setComposerMenu((value) => (value === 'repo' ? null : 'repo'))}
        />
        <input
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
          placeholder={`Message the orchestrator · ${activeRepoName ?? '…'}`}
          aria-label="Orchestrator composer"
          style={{
            flex: 1,
            borderWidth: 0,
            outline: 'none',
            background: 'transparent',
            color: 'var(--cnv-ink)',
            fontSize: 13,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            fontFamily: FONT,
          }}
        />
        <ChipButton
          label={CANVAS_MODEL_OPTIONS.find((option) => option.value === orcaModel)?.label ?? orcaModel}
          active={composerMenu === 'model'}
          onClick={() => setComposerMenu((value) => (value === 'model' ? null : 'model'))}
        />
        <ChipButton
          label={orcaEffort}
          active={composerMenu === 'effort'}
          onClick={() => setComposerMenu((value) => (value === 'effort' ? null : 'effort'))}
        />
        <button
          type="button"
          aria-label={orcaBusy ? 'Interrupt the orchestrator' : 'Send'}
          onClick={() => {
            if (orcaBusy) orca.interrupt();
            else submit();
          }}
          style={{
            borderWidth: 0,
            background: 'transparent',
            padding: 4,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: 'var(--cnv-ink-muted)',
            flexShrink: 0,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          {orcaBusy ? (
            <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" />
            </svg>
          )}
        </button>
      </div>

      {/* Composer menus — repo scope / model / thinking effort. */}
      <AnimatePresence>
        {composerMenu ? (
          <>
            <div role="presentation" onClick={() => setComposerMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              style={{
                position: 'absolute',
                bottom: 84,
                left: '50%',
                // framer owns `transform` while animating — offset by margin.
                marginLeft: -124,
                width: 248,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 14,
                zIndex: 46,
                ...glass(true),
              }}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 5 }}>
                {composerMenu === 'repo' ? 'Orchestrator repo' : composerMenu === 'model' ? 'Model' : 'Thinking effort'}
              </span>
              {composerMenu === 'repo' ? (repos ?? []).map((repo) => (
                <PickerRow
                  key={repo.path}
                  name={repo.name}
                  path={repo.path.replace(/^\/Users\/[^/]+/, '~')}
                  onClick={() => {
                    setActiveRepoPath(repo.path);
                    setComposerMenu(null);
                  }}
                />
              )) : null}
              {composerMenu === 'model' ? CANVAS_MODEL_OPTIONS.map((option) => (
                <PickerRow key={option.value} name={option.label} onClick={() => chooseModel(option.value)} />
              )) : null}
              {composerMenu === 'effort' ? THINKING_EFFORTS.map((effort) => (
                <PickerRow key={effort} name={effort} onClick={() => chooseEffort(effort)} />
              )) : null}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* Glass tuner — drops down under the "Canvas" word in the top dock. */}
      <AnimatePresence>
        {tunerOpen ? (
          <TunerPanel
            settings={settings}
            onChange={updateSettings}
            inTauri={inTauri}
            personalDefault={personalDefault}
            onSaveDefault={() => {
              savePersonalDefault(settings);
              setPersonalDefault({ ...settings });
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function PickerRow({ name, path, onClick }: { name: string; path?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1,
        borderWidth: 0,
        background: 'transparent',
        borderRadius: 9,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 8,
        paddingRight: 8,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: FONT,
        width: '100%',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ fontSize: 11.5, fontWeight: 400, letterSpacing: '-0.1px', color: 'var(--cnv-ink)' }}>{name}</span>
      {path ? (
        <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{path}</span>
      ) : null}
    </button>
  );
}

/** Small pill control in the composer — repo scope, model, thinking effort. */
function ChipButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 24,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--cnv-edge)',
        background: active ? 'var(--cnv-tint)' : 'transparent',
        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
        fontSize: 9.5,
        fontWeight: 400,
        letterSpacing: '0.02em',
        cursor: 'pointer',
        fontFamily: FONT,
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
    >
      {label}
    </button>
  );
}
