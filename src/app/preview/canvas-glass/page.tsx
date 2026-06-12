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
import { SmoothCorners } from '@lisse/react';
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
import { CanvasBackdropLayer } from './backdrops';
import { BrowserGlassCard, type BrowserCard, type BrowserTab } from './browser-card';
import { SpecGlassCard, type SpecCard } from './spec-card';
import { loadCanvasSnapshot, saveCanvasSnapshot, type SnapGeometry } from './canvas-persistence';
import { DIFF_MIN_H, DIFF_MIN_W, DiffGlassCard, type DiffCard } from './diff-card';
import { ChatGlassCard, type ChatCard } from './chat-card';
import { CanvasCard } from './cards';
import { DiffusionBackdrop, DockGlyphButton, EdgeRail, SpawnGlyphButton } from './chrome';
import { OrchestratorDock } from './dock';
import { FileGlassCard, type FileCard } from './file-card';
import { ImageGlassCard, type ImageCard } from './image-card';
import { TerminalGlassCard, type TermCard } from './terminal-card';
import { TunerPanel } from './tuner';
import { useCanvasOrchestrator, type OrcaThreadEvent } from './use-canvas-orchestrator';
import { FONT, IMG_MAX_SPAWN_EDGE, TONE_DOT, glass, glassPop, relAge, type CardKind, type DockEntry, type MockCard, type NewDockEntry, type OrcaThreadRow, type OrchestratorLane } from './ui';

/** Live rows for the wired chrome — inbox items, active lanes, commits. */
interface InboxRow {
  id: string;
  title: string;
  detail?: string | null;
  severity?: string | null;
  kind?: string | null;
}
interface LaneRow {
  id: string;
  label?: string | null;
  repoPath?: string | null;
  status?: string | null;
  runtime?: string | null;
}
interface CommitRow {
  hash: string;
  message: string;
  date: string;
}

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
  project: string | null;
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
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [composerValue, setComposerValue] = useState('');
  const [inTauri, setInTauri] = useState(false);
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
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsRepoFilter, setSessionsRepoFilter] = useState<string | null>(null);
  const [composerImages, setComposerImages] = useState<Array<{ name: string; dataUri: string }>>([]);
  const [diffCards, setDiffCards] = useState<DiffCard[]>([]);
  const [specCards, setSpecCards] = useState<SpecCard[]>([]);
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [browserCards, setBrowserCards] = useState<BrowserCard[]>([]);
  const [chatCards, setChatCards] = useState<ChatCard[]>([]);
  const [topMenu, setTopMenu] = useState<'alerts' | 'agents' | 'profile' | null>(null);
  const [inboxItems, setInboxItems] = useState<InboxRow[]>([]);
  const [activeLanes, setActiveLanes] = useState<LaneRow[]>([]);
  const [recentThreads, setRecentThreads] = useState<OrcaThreadRow[]>([]);
  const [recentCommits, setRecentCommits] = useState<CommitRow[]>([]);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
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
    Promise.all([
      fetch('/api/panel/repos').then((response) => (response.ok ? response.json() : { repos: [] })),
      fetch('/api/projects').then((response) => (response.ok ? response.json() : { projects: [] })).catch(() => ({ projects: [] })),
    ])
      .then(([data, projectData]: [
        { repos?: Array<{ id?: string | null; name?: string | null; localPath?: string | null }> },
        { projects?: Array<{ name?: string | null; repos?: Array<{ repoId?: string | null }> }> },
      ]) => {
        if (disposed) return;
        const projectByRepoId = new Map<string, string>();
        for (const project of projectData?.projects ?? []) {
          if (!project?.name) continue;
          for (const member of project.repos ?? []) {
            if (member?.repoId) projectByRepoId.set(member.repoId, project.name);
          }
        }
        const rows = Array.isArray(data?.repos)
          ? data.repos
            .filter((repo) => typeof repo?.localPath === 'string' && repo.localPath.length > 0)
            .map((repo) => ({
              name: repo.name && repo.name.length > 0 ? repo.name : (repo.localPath!.split('/').pop() ?? repo.localPath!),
              path: repo.localPath!,
              project: (repo.id && projectByRepoId.get(repo.id)) || null,
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

  // Live chrome data — inbox badge, running agents, past sessions. Light
  // polling: the canvas is ambient, not a realtime surface.
  useEffect(() => {
    let disposed = false;
    const refreshBadges = () => {
      fetch('/api/mobile/inbox')
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { items?: InboxRow[] } | null) => {
          if (!disposed && data && Array.isArray(data.items)) setInboxItems(data.items);
        })
        .catch(() => {});
      fetch('/api/lanes?active=true')
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { lanes?: LaneRow[] } | null) => {
          if (!disposed && data && Array.isArray(data.lanes)) setActiveLanes(data.lanes);
        })
        .catch(() => {});
    };
    const refreshThreads = () => {
      fetch('/api/mobile/orchestrator/threads')
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { threads?: OrcaThreadRow[] } | null) => {
          if (!disposed && data && Array.isArray(data.threads)) setRecentThreads(data.threads);
        })
        .catch(() => {});
    };
    refreshBadges();
    refreshThreads();
    const badgeTimer = setInterval(refreshBadges, 90_000);
    const threadTimer = setInterval(refreshThreads, 120_000);
    return () => {
      disposed = true;
      clearInterval(badgeTimer);
      clearInterval(threadTimer);
    };
  }, []);

  // Opening the Sessions popover refetches so the list is never two
  // minutes stale.
  useEffect(() => {
    if (!sessionsOpen) return;
    let disposed = false;
    fetch('/api/mobile/orchestrator/threads')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { threads?: OrcaThreadRow[] } | null) => {
        if (!disposed && data && Array.isArray(data.threads)) setRecentThreads(data.threads);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [sessionsOpen]);

  // Same for the Review drawer — lanes move fast, the list must be live.
  useEffect(() => {
    if (!reviewPickerOpen) return;
    let disposed = false;
    fetch('/api/lanes?active=true')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { lanes?: LaneRow[] } | null) => {
        if (!disposed && data && Array.isArray(data.lanes)) setActiveLanes(data.lanes);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [reviewPickerOpen]);

  // Right rail mirrors the active repo's recent commits.
  useEffect(() => {
    if (!activeRepoPath) return;
    let disposed = false;
    fetch(`/api/panel/commits?workspace=${encodeURIComponent(activeRepoPath)}&limit=5`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { commits?: CommitRow[] } | null) => {
        if (!disposed && data && Array.isArray(data.commits)) setRecentCommits(data.commits);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [activeRepoPath]);

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
      [lane]: (previous[lane] ?? []).map((entry) => {
        if (entry.role !== 'status' || !entry.pending) return entry;
        // A live tool cluster settles to its own tally, not the turn label.
        if (entry.kind === 'tool') {
          const count = entry.count ?? 1;
          return { ...entry, pending: false, text: `${count} action${count === 1 ? '' : 's'}` };
        }
        return { ...entry, pending: false, text };
      }),
    }));
  }, []);

  /** Tool calls absorb into one live cluster per work phase — the row
   *  shows the latest tool name + a running count instead of a pill per
   *  call. A text delta in between starts the next cluster. */
  const noteToolUse = useCallback((lane: string, name: string) => {
    setConvos((previous) => {
      const entries = previous[lane] ?? [];
      const last = entries[entries.length - 1];
      if (last && last.role === 'status' && last.kind === 'tool' && last.pending) {
        const updated = [...entries];
        updated[updated.length - 1] = { ...last, text: name, count: (last.count ?? 1) + 1 };
        return { ...previous, [lane]: updated };
      }
      const id = entryIdRef.current;
      entryIdRef.current += 1;
      return {
        ...previous,
        [lane]: [...entries.filter((e) => e.role !== 'followups'), { role: 'status', text: name, pending: true, kind: 'tool', count: 1, id }],
      };
    });
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

  /** ONE event pipeline for every live line — the dock's repo-keyed convo
   *  AND each chat card's thread-keyed convo flow through here. */
  const handleOrcaEvent = useCallback((lane: string, event: OrcaThreadEvent): void => {
    if (event.type === 'output') {
      if (event.thinking) return;
      if (!firstOutputRef.current.has(lane)) {
        firstOutputRef.current.add(lane);
        resolveStatus(lane, 'Working');
      }
      appendAssistantDelta(lane, event.text);
    } else if (event.type === 'tool') {
      if (!firstOutputRef.current.has(lane)) {
        firstOutputRef.current.add(lane);
        resolveStatus(lane, 'Working');
      }
      noteToolUse(lane, event.name);
    } else if (event.type === 'status') {
      if (event.status === 'dead') resolveStatus(lane, 'Session ended');
      else if (event.status === 'ready') resolveStatus(lane, 'Done');
    } else {
      resolveStatus(lane, 'Failed');
      appendEntries(lane, [{ role: 'status', text: event.error.slice(0, 200), pending: false }]);
    }
  }, [appendAssistantDelta, appendEntries, noteToolUse, resolveStatus]);

  // The REAL orchestrator — same ws-server channel the OrchestratorTab
  // speaks, scoped to the composer's repo. Convos are keyed by repo path.
  const orca = useCanvasOrchestrator(activeRepoPath, {
    onOutput: (repo, text, thinking) => {
      if (!thinking && !firstOutputRef.current.has(repo)) setDockOpen(true);
      handleOrcaEvent(repo, { type: 'output', text, thinking });
    },
    onToolUse: (repo, name) => {
      if (!firstOutputRef.current.has(repo)) setDockOpen(true);
      handleOrcaEvent(repo, { type: 'tool', name });
    },
    onStatus: (repo, status) => {
      setOrcaBusy(status === 'busy');
      handleOrcaEvent(repo, { type: 'status', status });
    },
    onError: (repo, error) => {
      handleOrcaEvent(repo, { type: 'error', error });
    },
  });

  /** One send path for every composer — the bottom pill AND the dock's
   *  own reply input. Returns true when the message went out. */
  const sendPrompt = useCallback((prompt: string, attachments?: Array<{ dataUri: string; name?: string }>): boolean => {
    if (!prompt || !activeRepoPath || orcaBusy) return false;
    firstOutputRef.current.delete(activeRepoPath);
    const threadId = orca.send(prompt, {
      model: orcaModel,
      thinkingEffort: orcaEffort,
      ...(attachments?.length ? { attachments } : {}),
    });
    const userText = attachments?.length
      ? `${prompt}\n\n· ${attachments.length} image${attachments.length === 1 ? '' : 's'} attached`
      : prompt;
    if (!threadId) {
      appendEntries(activeRepoPath, [
        { role: 'user', text: userText },
        { role: 'status', text: 'Not connected yet — try again in a second', pending: false },
      ]);
      setDockOpen(true);
      return false;
    }
    appendEntries(activeRepoPath, [
      { role: 'user', text: userText },
      { role: 'status', text: 'Thinking', pending: true },
    ]);
    return true;
  }, [activeRepoPath, appendEntries, orca, orcaBusy, orcaEffort, orcaModel]);

  /** Files dropped or pasted onto the composer become picture pills,
   *  ready to ride the next send as real image blocks. */
  const addComposerImages = useCallback((files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUri = typeof reader.result === 'string' ? reader.result : null;
        if (!dataUri) return;
        setComposerImages((previous) => previous.length >= 8 ? previous : [...previous, { name: file.name || 'image', dataUri }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const submit = useCallback(() => {
    const prompt = composerValue.trim();
    const images = composerImages;
    if (!prompt && images.length === 0) return;
    if (sendPrompt(prompt || 'Take a look at these.', images.length ? images : undefined)) {
      setComposerValue('');
      setComposerImages([]);
    }
  }, [composerImages, composerValue, sendPrompt]);

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

  /** A PAST session opens as its OWN draggable glass box — the dock stays
   *  reserved for the docked live orchestrator. The card's dock glyph
   *  promotes it into the dock if wanted. */
  const pickThread = useCallback((threadId: string, repoPath: string | null, meta?: { title?: string | null; repoName?: string | null }, at?: SnapGeometry) => {
    fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { messages?: Array<{ role?: string; content?: string }>; title?: string | null; repoName?: string | null; repoPath?: string | null } | null) => {
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        const entries: DockEntry[] = [];
        for (const message of messages) {
          const text = typeof message.content === 'string' ? message.content.trim() : '';
          if (!text) continue;
          const id = entryIdRef.current;
          entryIdRef.current += 1;
          entries.push(message.role === 'user' ? { role: 'user', text, id } : { role: 'text', text, id });
        }
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const firstUser = messages.find((message) => message.role === 'user');
        // The card's live convo lane starts from the history transcript —
        // its in-card composer streams onto the same lane from there.
        setConvos((previous) => ({ ...previous, [`thread:${threadId}`]: entries }));
        setChatCards((previous) => [...previous, {
          id,
          threadId,
          repoPath: repoPath ?? data?.repoPath ?? null,
          repoName: meta?.repoName ?? data?.repoName ?? null,
          title: meta?.title?.trim() || data?.title?.trim() || (typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 60) : 'Past session'),
          x: at?.x ?? 200 + (previous.length % 3) * 110 + (id % 5) * 8,
          y: at?.y ?? 90 + (previous.length % 3) * 70,
          z: zPeakRef.current,
          w: at?.w ?? 380,
          h: at?.h ?? 400,
          entries,
        }]);
      })
      .catch(() => {});
  }, []);

  /** A chat card's own composer went out — append the turn to its lane.
   *  Mirrors sendPrompt's entry shapes; the card already did the ws send. */
  const noteCardSend = useCallback((card: ChatCard, text: string, sent: boolean) => {
    const lane = `thread:${card.threadId}`;
    firstOutputRef.current.delete(lane);
    appendEntries(lane, sent
      ? [{ role: 'user', text }, { role: 'status', text: 'Thinking', pending: true }]
      : [{ role: 'user', text }, { role: 'status', text: 'Not connected yet — try again in a second', pending: false }]);
  }, [appendEntries]);

  const moveChatCard = useCallback((id: number, x: number, y: number) => {
    setChatCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeChatCard = useCallback((id: number, w: number, h: number) => {
    setChatCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, []);

  const closeChatCard = useCallback((id: number) => {
    setChatCards((previous) => previous.filter((card) => card.id !== id));
  }, []);

  /** Promote a chat card into the dock — adopt its thread on the live
   *  socket; the next composer message continues that conversation. */
  const dockChatCard = useCallback((card: ChatCard) => {
    const repo = card.repoPath ?? activeRepoPath;
    if (!repo) return;
    setActiveRepoPath(repo);
    orca.adoptThread(repo, card.threadId);
    setConvos((previous) => ({ ...previous, [repo]: previous[`thread:${card.threadId}`] ?? card.entries }));
    setChatCards((previous) => previous.filter((existing) => existing.id !== card.id));
    setDockOpen(true);
  }, [activeRepoPath, orca]);

  const moveCard = useCallback((id: number, x: number, y: number) => {
    setCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  /** Spawn a REAL shell — production transport, canvas treatment. */
  const spawnTerminal = useCallback((cwd: string | null, cwdLabel: string | null, at?: SnapGeometry) => {
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
      x: at?.x ?? 240 + (previous.length % 3) * 120 + (id % 5) * 10,
      y: at?.y ?? 110 + (previous.length % 3) * 80,
      w: at?.w ?? 560,
      h: at?.h ?? 300,
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

  /** Clicked card comes forward. Terminals + files + images + browsers +
   *  chats share the 10–39 band — above mock cards (3), below chrome (40+). */
  const focusCard = useCallback((kind: 'term' | 'file' | 'image' | 'browser' | 'chat' | 'diff' | 'spec', id: number) => {
    const current = kind === 'term'
      ? termCards.find((card) => card.id === id)
      : kind === 'file'
        ? fileCards.find((card) => card.id === id)
        : kind === 'image'
          ? imageCards.find((card) => card.id === id)
          : kind === 'browser'
            ? browserCards.find((card) => card.id === id)
            : kind === 'chat'
              ? chatCards.find((card) => card.id === id)
              : kind === 'diff'
                ? diffCards.find((card) => card.id === id)
                : specCards.find((card) => card.id === id);
    if (!current || current.z === zPeakRef.current) return;
    if (zPeakRef.current + 1 > 38) {
      // Renormalize the whole band, keeping order, with the target on top.
      const combined = [
        ...termCards.map((card) => ({ kind: 'term' as const, id: card.id, z: card.z })),
        ...fileCards.map((card) => ({ kind: 'file' as const, id: card.id, z: card.z })),
        ...imageCards.map((card) => ({ kind: 'image' as const, id: card.id, z: card.z })),
        ...browserCards.map((card) => ({ kind: 'browser' as const, id: card.id, z: card.z })),
        ...chatCards.map((card) => ({ kind: 'chat' as const, id: card.id, z: card.z })),
        ...diffCards.map((card) => ({ kind: 'diff' as const, id: card.id, z: card.z })),
        ...specCards.map((card) => ({ kind: 'spec' as const, id: card.id, z: card.z })),
      ].sort((a, b) => a.z - b.z);
      const remap = new Map(combined.map((entry, index) => [`${entry.kind}:${entry.id}`, 10 + index]));
      const top = 10 + combined.length;
      setTermCards((previous) => previous.map((card) => ({ ...card, z: kind === 'term' && card.id === id ? top : remap.get(`term:${card.id}`) ?? card.z })));
      setFileCards((previous) => previous.map((card) => ({ ...card, z: kind === 'file' && card.id === id ? top : remap.get(`file:${card.id}`) ?? card.z })));
      setImageCards((previous) => previous.map((card) => ({ ...card, z: kind === 'image' && card.id === id ? top : remap.get(`image:${card.id}`) ?? card.z })));
      setBrowserCards((previous) => previous.map((card) => ({ ...card, z: kind === 'browser' && card.id === id ? top : remap.get(`browser:${card.id}`) ?? card.z })));
      setChatCards((previous) => previous.map((card) => ({ ...card, z: kind === 'chat' && card.id === id ? top : remap.get(`chat:${card.id}`) ?? card.z })));
      setDiffCards((previous) => previous.map((card) => ({ ...card, z: kind === 'diff' && card.id === id ? top : remap.get(`diff:${card.id}`) ?? card.z })));
      setSpecCards((previous) => previous.map((card) => ({ ...card, z: kind === 'spec' && card.id === id ? top : remap.get(`spec:${card.id}`) ?? card.z })));
      zPeakRef.current = top;
      return;
    }
    zPeakRef.current += 1;
    const z = zPeakRef.current;
    if (kind === 'term') {
      setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'file') {
      setFileCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'image') {
      setImageCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'browser') {
      setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'chat') {
      setChatCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'diff') {
      setDiffCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else {
      setSpecCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    }
  }, [browserCards, chatCards, diffCards, fileCards, imageCards, specCards, termCards]);

  const focusTermCard = useCallback((id: number) => focusCard('term', id), [focusCard]);
  const focusFileCard = useCallback((id: number) => focusCard('file', id), [focusCard]);
  const focusImageCard = useCallback((id: number) => focusCard('image', id), [focusCard]);
  const focusBrowserCard = useCallback((id: number) => focusCard('browser', id), [focusCard]);
  const focusChatCard = useCallback((id: number) => focusCard('chat', id), [focusCard]);
  const focusDiffCard = useCallback((id: number) => focusCard('diff', id), [focusCard]);
  const focusSpecCard = useCallback((id: number) => focusCard('spec', id), [focusCard]);

  /** A lane's review diff lands as a glass card — the governance moat
   *  as a canvas object. */
  const spawnDiffCard = useCallback((lane: LaneRow, at?: SnapGeometry) => {
    fetch(`/api/lanes/${encodeURIComponent(lane.id)}/diff?maxBytes=131072`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; packetId?: string | null; branch?: string | null; stat?: string; diff?: string; truncated?: boolean } | null) => {
        if (!data?.ok) return;
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        setDiffCards((previous) => [...previous, {
          id,
          x: at?.x ?? 180 + (previous.length % 3) * 90 + (id % 5) * 8,
          y: at?.y ?? 88 + (previous.length % 3) * 56,
          z: zPeakRef.current,
          w: at?.w ?? 560,
          h: at?.h ?? 320,
          laneId: lane.id,
          packetId: data.packetId ?? null,
          title: lane.label?.trim() || lane.id,
          branch: data.branch ?? null,
          stat: data.stat ?? '',
          diff: data.diff ?? '',
          truncated: Boolean(data.truncated),
        }]);
      })
      .catch(() => {});
  }, []);

  /** The operator's o8.md notes — the REAL spec pane in a glass card.
   *  One card per repo: a second click focuses the open one instead of
   *  spawning a duplicate editor against the same file. */
  const spawnSpecCard = useCallback(() => {
    const repoPath = activeRepoPath ?? null;
    const open = specCards.find((card) => card.repoPath === repoPath);
    if (open) {
      focusSpecCard(open.id);
      return;
    }
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    setSpecCards((previous) => [...previous, {
      id,
      x: 200 + (previous.length % 3) * 100 + (id % 5) * 8,
      y: 84 + (previous.length % 3) * 60,
      z: zPeakRef.current,
      w: 760,
      h: 540,
      repoPath,
    }]);
  }, [activeRepoPath, focusSpecCard, specCards]);

  /** A REAL browser pane — defaults to the app's own dashboard. */
  const spawnBrowserCard = useCallback(() => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    setBrowserCards((previous) => [...previous, {
      id,
      x: 220 + (previous.length % 3) * 110 + (id % 5) * 8,
      y: 96 + (previous.length % 3) * 70,
      z: zPeakRef.current,
      w: 640,
      h: 400,
      tabs: [{ id: 1, url: `${window.location.origin}/dashboard` }],
      activeTabId: 1,
    }]);
  }, []);

  // Agents reach this browser too — o8_view_open_browser (operator MCP)
  // dispatches this same event for the default side; on canvas it lands as
  // a browser card. New tab per URL, reusing an existing tab on a match.
  useEffect(() => {
    const onOpenBrowser = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string | null }>).detail?.url?.trim() || `${window.location.origin}/dashboard`;
      setBrowserCards((previous) => {
        if (previous.length === 0) {
          const id = nextIdRef.current;
          nextIdRef.current += 1;
          zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
          return [{ id, x: 240, y: 110, z: zPeakRef.current, w: 640, h: 400, tabs: [{ id: 1, url }], activeTabId: 1 }];
        }
        const top = previous.reduce((best, card) => (card.z > best.z ? card : best), previous[0]);
        return previous.map((card) => {
          if (card.id !== top.id) return card;
          const existing = card.tabs.find((tab) => tab.url === url);
          if (existing) return { ...card, activeTabId: existing.id };
          const nextTabId = card.tabs.reduce((max, tab) => Math.max(max, tab.id), 0) + 1;
          return { ...card, tabs: [...card.tabs, { id: nextTabId, url }], activeTabId: nextTabId };
        });
      });
    };
    window.addEventListener('o8:open-browser', onOpenBrowser);
    return () => window.removeEventListener('o8:open-browser', onOpenBrowser);
  }, []);

  const moveBrowserCard = useCallback((id: number, x: number, y: number) => {
    setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeBrowserCard = useCallback((id: number, w: number, h: number) => {
    setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, []);

  const changeBrowserTabs = useCallback((id: number, tabs: BrowserTab[], activeTabId: number) => {
    setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, tabs, activeTabId } : card)));
  }, []);

  const closeBrowserCard = useCallback((id: number) => {
    setBrowserCards((previous) => previous.filter((card) => card.id !== id));
  }, []);

  const changeTermVeil = useCallback((value: number) => {
    setTermVeil(value);
    try {
      window.localStorage.setItem(TERM_VEIL_KEY, String(value));
    } catch {
      // non-critical — the dialed value just won't survive reload
    }
  }, []);

  /** Open ANY file on the machine as a glass card — view, edit, ⌘S. */
  const spawnFileCard = useCallback((path: string, at?: SnapGeometry) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const z = zPeakRef.current;
    setFileCards((previous) => [...previous, {
      id,
      path,
      name: path.split('/').pop() || path,
      x: at?.x ?? 300 + (previous.length % 3) * 90 + (id % 5) * 8,
      y: at?.y ?? 96 + (previous.length % 3) * 64,
      w: at?.w ?? 620,
      h: at?.h ?? 420,
      z,
    }]);
  }, []);

  // ── Canvas persistence — the canvas is a place, not a session. ──────
  // Restore once on mount: pure-state kinds land directly, live kinds go
  // back through their real spawn paths (terminals respawn shells in the
  // saved cwd, chat cards refetch their thread, diff cards refetch the
  // lane and silently drop if it's gone).
  const restoredRef = useRef(false);
  const persistArmedAtRef = useRef(0);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    persistArmedAtRef.current = Date.now() + 4000;
    const snap = loadCanvasSnapshot();
    if (!snap) return;
    if (snap.activeRepoPath) setActiveRepoPath((current) => current ?? snap.activeRepoPath);
    if (snap.dockOpen) setDockOpen(true);

    if (snap.browser.length) {
      setBrowserCards((previous) => [...previous, ...snap.browser.map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, tabs: saved.tabs, activeTabId: saved.activeTabId };
      })]);
    }
    if (snap.spec.length) {
      setSpecCards((previous) => [...previous, ...snap.spec.map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, repoPath: saved.repoPath };
      })]);
    }
    if (snap.image.length) {
      setImageCards((previous) => [...previous, ...snap.image.map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, aspect: saved.aspect, items: saved.items };
      })]);
    }
    snap.file.forEach((saved) => spawnFileCard(saved.path, saved));
    snap.chat.forEach((saved) => pickThread(saved.threadId, saved.repoPath, { title: saved.title, repoName: saved.repoName }, saved));
    snap.diff.forEach((saved) => spawnDiffCard({ id: saved.laneId, label: saved.title }, saved));
    if (snap.term.length) {
      // The terminal ws needs a beat to connect before create requests land.
      setTimeout(() => snap.term.forEach((saved) => spawnTerminal(saved.cwd, saved.cwdLabel, saved)), 1200);
    }
  }, [pickThread, spawnDiffCard, spawnFileCard, spawnTerminal]);

  // Save: one debounced snapshot whenever anything persistent changes.
  // The signature string IS the snapshot body — transient fields (term
  // liveness, diff text, chat entries) are excluded so churn never
  // thrashes localStorage.
  const persistSignature = JSON.stringify({
    activeRepoPath,
    dockOpen,
    term: termCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, cwd: card.cwd, cwdLabel: card.cwdLabel })),
    file: fileCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, path: card.path })),
    image: imageCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, aspect: card.aspect, items: card.items })),
    browser: browserCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, tabs: card.tabs, activeTabId: card.activeTabId })),
    chat: chatCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, threadId: card.threadId, repoPath: card.repoPath, repoName: card.repoName, title: card.title })),
    diff: diffCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, laneId: card.laneId, title: card.title })),
    spec: specCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, repoPath: card.repoPath })),
  });
  useEffect(() => {
    // Hold fire until restore's async spawns settle — an instant save of
    // the half-restored canvas would overwrite the snapshot.
    if (!restoredRef.current || Date.now() < persistArmedAtRef.current) return;
    const timer = setTimeout(() => {
      saveCanvasSnapshot({ v: 1, ...JSON.parse(persistSignature) });
    }, 700);
    return () => clearTimeout(timer);
  }, [persistSignature]);

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
    const chat = chatCards.find((card) => matches(card.title) || matches(card.repoName));
    if (chat) { focusCard('chat', chat.id); return; }
    const mock = cards.find((card) => matches(card.title));
    if (mock) setSelectedCardId(mock.id);
  }, [cards, chatCards, fileCards, focusCard, imageCards, searchQuery, termCards]);

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
    // In the app the transparent window loses macOS's corner mask — clip the
    // whole canvas to the window radius ourselves (continuous curve). The
    // desktop reads through the clipped corners, restoring the Apple edge.
    <SmoothCorners
      corners={{ radius: inTauri ? 12 : 0 }}
      autoEffects={false}
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

      {/* Depth layer — the paper/shader mood from the Canvas tuner. */}
      <CanvasBackdropLayer kind={settings.backdrop} />

      {/* Center emblem retired (operator call 2026-06-12) — the empty
          canvas stays clean; a logo / Lottie motion piece comes later. */}

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

      {/* ── Browser cards — a real page in glass ─────────────────── */}
      <AnimatePresence>
        {browserCards.map((card) => (
          <BrowserGlassCard
            key={card.id}
            card={card}
            onMove={moveBrowserCard}
            onResize={resizeBrowserCard}
            onFocus={focusBrowserCard}
            onTabsChange={changeBrowserTabs}
            onClose={closeBrowserCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Diff cards — the governance moat as canvas objects ────── */}
      <AnimatePresence>
        {diffCards.map((card) => (
          <DiffGlassCard
            key={card.id}
            card={card}
            onMove={(id, x, y) => setDiffCards((previous) => previous.map((c) => (c.id === id ? { ...c, x, y } : c)))}
            onResize={(id, w, h) => setDiffCards((previous) => previous.map((c) => (c.id === id ? { ...c, w, h } : c)))}
            onFocus={focusDiffCard}
            onClose={(id) => setDiffCards((previous) => previous.filter((c) => c.id !== id))}
            onRequestChanges={(diffCard) => {
              setComposerValue(`Request changes on ${diffCard.title}${diffCard.branch ? ` (${diffCard.branch})` : ''}: `);
              composerInputRef.current?.focus();
            }}
          />
        ))}
      </AnimatePresence>

      {/* ── o8.md cards — the operator's notes, full spec-pane parity ── */}
      <AnimatePresence>
        {specCards.map((card) => (
          <SpecGlassCard
            key={card.id}
            card={card}
            onMove={(id, x, y) => setSpecCards((previous) => previous.map((c) => (c.id === id ? { ...c, x, y } : c)))}
            onResize={(id, w, h) => setSpecCards((previous) => previous.map((c) => (c.id === id ? { ...c, w, h } : c)))}
            onFocus={focusSpecCard}
            onClose={(id) => setSpecCards((previous) => previous.filter((c) => c.id !== id))}
          />
        ))}
      </AnimatePresence>

      {/* ── Chat cards — past sessions as their own glass boxes ───── */}
      <AnimatePresence>
        {chatCards.map((card) => (
          <ChatGlassCard
            key={card.id}
            card={card}
            liveEntries={convos[`thread:${card.threadId}`] ?? null}
            sendDefaults={{ model: orcaModel, thinkingEffort: orcaEffort }}
            onLiveEvent={handleOrcaEvent}
            onUserSend={noteCardSend}
            onMove={moveChatCard}
            onResize={resizeChatCard}
            onFocus={focusChatCard}
            onDock={dockChatCard}
            onClose={closeChatCard}
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
        <DockGlyphButton
          label="Agents"
          active={topMenu === 'agents'}
          badge={activeLanes.length}
          onClick={() => setTopMenu((value) => (value === 'agents' ? null : 'agents'))}
          path="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"
          extra={<circle cx="9" cy="7" r="4" />}
        />
        <DockGlyphButton
          label="Alerts"
          active={topMenu === 'alerts'}
          badge={inboxItems.length}
          onClick={() => setTopMenu((value) => (value === 'alerts' ? null : 'alerts'))}
          path="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
        />
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

      {/* Top-dock popovers — live agents / live inbox, real data. */}
      <AnimatePresence>
        {topMenu === 'agents' || topMenu === 'alerts' ? (
          <>
            <div role="presentation" onClick={() => setTopMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              style={{
                position: 'absolute',
                top: 64,
                left: '50%',
                marginLeft: -150,
                width: 300,
                maxHeight: 320,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 6,
                paddingRight: 6,
                borderRadius: 13,
                zIndex: 46,
                scrollbarWidth: 'none',
                ...glassPop(),
              } as React.CSSProperties}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 4 }}>
                {topMenu === 'agents' ? 'Running agents' : 'Inbox'}
              </span>
              {topMenu === 'agents' ? (
                activeLanes.length === 0 ? (
                  <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingTop: 2, paddingBottom: 4 }}>
                    No agents running — dispatch from the orchestrator below.
                  </span>
                ) : (
                  activeLanes.slice(0, 10).map((lane) => (
                    <div key={lane.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          flexShrink: 0,
                          background: lane.status === 'running' || lane.status === 'launching'
                            ? '#22c55e'
                            : lane.status === 'awaiting_input' || lane.status === 'reviewing'
                              ? '#f59e0b'
                              : lane.status === 'failed'
                                ? '#ef4444'
                                : 'rgba(255,255,255,0.4)',
                        }}
                      />
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, fontFamily: FONT }}>
                        <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {lane.label || lane.id}
                        </span>
                        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                          {[lane.repoPath?.split('/').pop(), lane.runtime, lane.status].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </div>
                  ))
                )
              ) : inboxItems.length === 0 ? (
                <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingTop: 2, paddingBottom: 4 }}>
                  Inbox zero — nothing needs you.
                </span>
              ) : (
                inboxItems.slice(0, 10).map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8 }}>
                    <span
                      aria-hidden
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        flexShrink: 0,
                        marginTop: 4,
                        background: item.severity === 'critical' || item.severity === 'high'
                          ? '#ef4444'
                          : item.kind === 'approval' || item.severity === 'warning'
                            ? '#f59e0b'
                            : 'rgba(255,255,255,0.4)',
                      }}
                    />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, fontFamily: FONT }}>
                      <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </span>
                      {item.detail ? (
                        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.detail}
                        </span>
                      ) : null}
                    </span>
                  </div>
                ))
              )}
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

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
          {/* width/height as inline style — attribute sizing collapses to 0
              in this flex context (the missing-search-icon bug). */}
          <svg style={{ width: 13, height: 13, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Operator profile"
          onClick={() => setTopMenu((value) => (value === 'profile' ? null : 'profile'))}
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--cnv-edge)',
            background: 'var(--cnv-tint)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: topMenu === 'profile' ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
            flexShrink: 0,
            cursor: 'pointer',
            padding: 0,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { if (topMenu !== 'profile') event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          <svg style={{ width: 12, height: 12, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
        </button>
      </div>

      {/* Profile popover — the door to plan & account once accounts land. */}
      <AnimatePresence>
        {topMenu === 'profile' ? (
          <>
            <div role="presentation" onClick={() => setTopMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              style={{
                position: 'absolute',
                top: 64,
                right: 24,
                width: 220,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                paddingTop: 12,
                paddingBottom: 12,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 13,
                zIndex: 46,
                ...glassPop(),
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', fontFamily: FONT }}>Operator</span>
              <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.55, fontFamily: FONT }}>
                Profile, plan, and usage land here with accounts. This avatar is the door.
              </span>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

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
              ...glassPop(),
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
        <SpawnGlyphButton
          label="Message the orchestrator"
          onClick={() => {
            if ((convos[activeRepoPath ?? '']?.length ?? 0) > 0) setDockOpen(true);
            composerInputRef.current?.focus();
          }}
        >
          <circle cx="12" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M12 8v4M12 12l-6 4M12 12l6 4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Sessions" onClick={() => setSessionsOpen((value) => !value)}>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn browser" onClick={spawnBrowserCard}>
          <circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Spawn terminal" onClick={toggleTermPicker}>
          <path d="m4 17 6-6-6-6" /><line x1="12" x2="20" y1="19" y2="19" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Open file" onClick={openFilePicker}>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Review diffs" onClick={() => setReviewPickerOpen((value) => !value)}>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect width="8" height="4" x="8" y="2" rx="1" /><path d="m9 14 2 2 4-4" />
        </SpawnGlyphButton>
        <SpawnGlyphButton label="Open o8.md" onClick={spawnSpecCard}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </SpawnGlyphButton>
      </div>

      {/* ── Terminal cwd drawer — same system as the Sessions drawer:
            tuner-matched glass, hard edges, the list dissolves at both
            ends as you scroll. ───── */}
      <AnimatePresence>
        {termPickerOpen ? (
          <>
            <div role="presentation" onClick={() => setTermPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              style={{
                position: 'absolute',
                left: 64,
                top: 74,
                bottom: 96,
                width: 272,
                display: 'flex',
                flexDirection: 'column',
                paddingTop: 12,
                paddingBottom: 4,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 6,
                zIndex: 46,
                ...glass(true),
              }}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 7 }}>
                Open terminal in
              </span>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingTop: 14,
                  paddingBottom: 18,
                  scrollbarWidth: 'none',
                  maskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                } as React.CSSProperties}
              >
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
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* ── Review drawer — live lanes; in-review first. Click one and
            its diff lands as a glass card with the governance actions. */}
      <AnimatePresence>
        {reviewPickerOpen ? (
          <>
            <div role="presentation" onClick={() => setReviewPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              style={{
                position: 'absolute',
                left: 64,
                top: 74,
                bottom: 96,
                width: 272,
                display: 'flex',
                flexDirection: 'column',
                paddingTop: 12,
                paddingBottom: 4,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 6,
                zIndex: 46,
                ...glass(true),
              }}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 7 }}>
                Review
              </span>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingTop: 14,
                  paddingBottom: 18,
                  scrollbarWidth: 'none',
                  maskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                } as React.CSSProperties}
              >
                {activeLanes.length === 0 ? (
                  <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', paddingLeft: 8, paddingTop: 2, paddingBottom: 4, fontFamily: FONT, lineHeight: 1.6 }}>
                    Nothing running — dispatch from the composer and the diffs land here.
                  </span>
                ) : (
                  [...activeLanes]
                    .sort((a, b) => Number((b.status ?? '').includes('review')) - Number((a.status ?? '').includes('review')))
                    .map((lane) => (
                      <button
                        key={lane.id}
                        type="button"
                        onClick={() => {
                          spawnDiffCard(lane);
                          setReviewPickerOpen(false);
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: 7, paddingTop: 7, paddingBottom: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', width: '100%' }}
                        onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                      >
                        <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: (lane.status ?? '').includes('review') ? TONE_DOT.waiting : TONE_DOT.working, flexShrink: 0 }} />
                        <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 210 }}>
                            {lane.label?.trim() || lane.id}
                          </span>
                          <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                            {[lane.status, lane.runtime].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </button>
                    ))
                )}
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* ── Sessions drawer — history lives on the left, like the
            default page. Glass matches the operator's tuner (no opaque
            slab), hard edges, and the list dissolves at both ends as
            you scroll — the cue that older sessions are down there. */}
      <AnimatePresence>
        {sessionsOpen ? (
          <>
            <div role="presentation" onClick={() => setSessionsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              style={{
                position: 'absolute',
                left: 64,
                top: 74,
                bottom: 96,
                width: 272,
                display: 'flex',
                flexDirection: 'column',
                paddingTop: 12,
                paddingBottom: 4,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 6,
                zIndex: 46,
                ...glass(true),
              }}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 7 }}>
                Sessions
              </span>
              {/* Repo filter — newest-first stays the spine; chips narrow it. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 6, paddingRight: 6, paddingBottom: 4 }}>
                {[null, ...[...new Set(recentThreads.map((thread) => thread.repoName).filter(Boolean))]].map((repoName) => {
                  const active = sessionsRepoFilter === repoName;
                  return (
                    <button
                      key={repoName ?? 'all'}
                      type="button"
                      onClick={() => setSessionsRepoFilter(repoName as string | null)}
                      style={{
                        borderWidth: 1,
                        borderStyle: 'solid',
                        borderColor: active ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
                        background: active ? 'rgba(255,255,255,0.1)' : 'transparent',
                        borderRadius: 999,
                        paddingTop: 2,
                        paddingBottom: 2,
                        paddingLeft: 9,
                        paddingRight: 9,
                        fontSize: 9.5,
                        fontWeight: active ? 500 : 300,
                        color: active ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                        cursor: 'pointer',
                        fontFamily: FONT,
                      }}
                    >
                      {repoName ?? 'All'}
                    </button>
                  );
                })}
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  paddingTop: 14,
                  paddingBottom: 18,
                  scrollbarWidth: 'none',
                  maskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 26px, black calc(100% - 30px), transparent 100%)',
                } as React.CSSProperties}
              >
              {(convos[activeRepoPath ?? '']?.length ?? 0) > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setDockOpen(true);
                    setSessionsOpen(false);
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, paddingTop: 7, paddingBottom: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', width: '100%' }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: orcaBusy ? TONE_DOT.working : TONE_DOT.idle, flexShrink: 0 }} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--cnv-ink)', letterSpacing: '-0.1px' }}>
                      Live — {activeRepoName ?? 'orchestrator'}
                    </span>
                    <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                      {orcaBusy ? 'Working now · open the dock' : 'Open the dock'}
                    </span>
                  </span>
                </button>
              ) : null}
              {recentThreads.length === 0 ? (
                <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', paddingLeft: 8, paddingTop: 2, paddingBottom: 4, fontFamily: FONT }}>
                  No orchestrator sessions yet — talk below.
                </span>
              ) : (
                recentThreads.filter((thread) => !sessionsRepoFilter || thread.repoName === sessionsRepoFilter).slice(0, 20).map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => {
                      pickThread(thread.id, thread.repoPath, { title: thread.title, repoName: thread.repoName });
                      setSessionsOpen(false);
                    }}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', width: '100%' }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                      {thread.title?.trim() || 'Untitled session'}
                    </span>
                    <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                      {[thread.repoName, relAge(thread.lastMessageAt)].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                ))
              )}
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      {/* ── Edge hover rail — real commits on the right ──────────── */}
      {dockOpen ? null : (
        <EdgeRail
          side="right"
          open={rightRailOpen}
          onOpenChange={setRightRailOpen}
          title="Activity"
          rows={recentCommits.slice(0, 5).map((commit) => [
            commit.message,
            [commit.hash, relAge(commit.date)].filter(Boolean).join(' · '),
          ])}
          emptyHint="No recent commits on this repo."
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
            onSend={sendPrompt}
            busy={orcaBusy}
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

      {/* Picture pills — images dropped or pasted on the composer wait
          here, then ride the next send as real image blocks. */}
      <AnimatePresence>
        {composerImages.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            style={{
              position: 'absolute',
              bottom: 78,
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 8,
              paddingRight: 8,
              borderRadius: 13,
              zIndex: 40,
              ...glass(true),
            }}
          >
            {composerImages.map((image, index) => (
              <div key={`${image.name}-${index}`} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, paddingRight: 4 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.dataUri} alt={image.name} style={{ width: 30, height: 30, borderRadius: 7, objectFit: 'cover', display: 'block' }} />
                <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {image.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => setComposerImages((previous) => previous.filter((_, i) => i !== index))}
                  style={{ borderWidth: 0, background: 'transparent', padding: 2, color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontSize: 10, fontFamily: FONT }}
                  onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
                >
                  ✕
                </button>
              </div>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Bottom orchestrator input — first contact lives here ─── */}
      <div
        onDragOver={(event) => {
          // Claim drags over the composer — the page-level veil stays out
          // of it and the drop becomes a picture pill, not a canvas card.
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer?.files?.length) addComposerImages(event.dataTransfer.files);
        }}
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
          ref={composerInputRef}
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
            if (files.length) {
              event.preventDefault();
              addComposerImages(files);
            }
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
                ...glassPop(),
              }}
            >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 5 }}>
                {composerMenu === 'repo' ? 'Orchestrator repo' : composerMenu === 'model' ? 'Model' : 'Thinking effort'}
              </span>
              {composerMenu === 'repo' ? (() => {
                const rows = repos ?? [];
                const projectNames = [...new Set(rows.map((row) => row.project).filter((value): value is string => Boolean(value)))];
                const groups = [
                  ...projectNames.map((label) => ({ label, rows: rows.filter((row) => row.project === label) })),
                  { label: projectNames.length ? 'Independent' : null, rows: rows.filter((row) => !row.project) },
                ].filter((group) => group.rows.length > 0);
                return groups.map((group) => (
                  <div key={group.label ?? 'solo'} style={{ display: 'flex', flexDirection: 'column' }}>
                    {group.label ? (
                      <span style={{ fontSize: 8.5, fontWeight: 300, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingTop: 8, paddingBottom: 3, opacity: 0.8 }}>
                        {group.label}
                      </span>
                    ) : null}
                    {group.rows.map((repo) => (
                      <PickerRow
                        key={repo.path}
                        name={repo.name}
                        path={repo.path.replace(/^\/Users\/[^/]+/, '~')}
                        onClick={() => {
                          setActiveRepoPath(repo.path);
                          setComposerMenu(null);
                        }}
                      />
                    ))}
                  </div>
                ));
              })() : null}
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
    </SmoothCorners>
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
