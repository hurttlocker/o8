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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useReducedMotion } from 'framer-motion';
import { SmoothCorners } from '@lisse/react';
import {
  CANVAS_GLASS_DEFAULTS,
  applyCanvasGlassSettings,
  canvasFreeLook,
  canvasFreeLookIdFor,
  readCanvasGlassSettings,
  readPersonalDefault,
  savePersonalDefault,
  writeCanvasGlassSettings,
  type CanvasGlassSettings,
} from '@/lib/canvas-mode/glass-settings';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { checkAliveSessions } from '@/lib/terminal/tab-state';
import { RealtimeVoiceHost } from '@/components/desktop/dictation/RealtimeVoiceHost';
import { isTauri, onFileOpenRequest, setCanvasBackdropBlur, setCanvasMaterial, symonSpeakStatus, takePendingFileOpens } from '@/lib/tauri/bridge';
import { useDesktopWebSocket } from '@/components/desktop/hooks/useDesktopWebSocket';
import { useDictationHostOptional } from '@/components/desktop/dictation/DictationHost';
import { MicButton } from '@/components/desktop/thoughts/MicButton';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { DEFAULT_ORCHESTRATOR_MODEL } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';
import { THINKING_EFFORTS, isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { usableCanvasArea } from './canvas-drag';
import { carveChrome, chromeRectsCanvas } from './chrome-rects';
import { computeGrid, slotToCardGeom, type GridItem, type Slot } from './form-fit';
import { NavigatorLoupe, type MinimapCard } from './navigator-loupe';
import { ORB_DEFAULTS, readOrbSettings, writeOrbSettings, type OrbSettings } from './orb-settings';
import { CanvasBackdropLayer } from './backdrops';
import { BrowserGlassCard, type BrowserCard, type BrowserTab } from './browser-card';
import { SpecGlassCard, type SpecCard } from './spec-card';
import { BrainGlassCard, type BrainCard } from './brain-card';
import { MarkdownGlassCard, type MarkdownCard } from './markdown-card';
import { loadCanvasSnapshot, saveCanvasSnapshot, type SnapGeometry } from './canvas-persistence';
import { DIFF_MIN_H, DIFF_MIN_W, DiffGlassCard, type DiffCard } from './diff-card';
import { AgentGlassCard, AGENT_FULL_W, AGENT_FULL_H, AGENT_COMPACT_W, AGENT_COMPACT_H, type AgentCard } from './agent-card';
import { codename } from '@/lib/agents/codename';
import { ChatGlassCard, type ChatCard } from './chat-card';
import { CanvasCard } from './cards';
import { DiffusionBackdrop, DockGlyphButton, EdgeRail, SpawnGlyphButton } from './chrome';
import { CanvasFeedbackButton } from './canvas-feedback';
import { ViewAsFreeIndicator } from '@/components/desktop/ViewAsFreeIndicator';
import { ProximityDock } from './proximity-dock';
import { AnticipationRing } from './anticipation-ring';
import { ComposerPartialsFill, useAgentPartialsMorph } from './agent-partials-morph';
import { OrchestratorDock } from './dock';
import type { SwarmScoutView } from '@/components/desktop/thoughts/chat-panel/SwarmStatusCard';
import { FileGlassCard, type FileCard } from './file-card';
import { ImageGlassCard, type ImageCard } from './image-card';
import { VideoGlassCard, type VideoCard } from './video-card';
import { putMedia, getMedia, deleteMedia } from './canvas-media-store';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { TerminalGlassCard, type TermCard } from './terminal-card';
import { TunerPanel } from './tuner';
import { WelcomeModal } from './welcome-modal';
import { ShareBetaModal } from './share-beta';
import { CanvasTour } from './canvas-tour';
import { useCanvasOrchestrator, type OrcaThreadEvent } from './use-canvas-orchestrator';
import { useSendBuffer, UndoSendPill, QueuedSends, SEND_UNDO_GRACE_MS, type ComposerImage } from './use-send-buffer';
import { DispatchDock, phaseFor, type DispatchLane } from './dispatch-dock';
import { emptyTurnTools, recordTool, recordToolResult, synthesizeResultEntries, type TurnTools } from './result-cards';
import { CARD_ENTRANCE, FONT, IMG_MAX_SPAWN_EDGE, TONE_DOT, canvasZoom, glass, glassPop, relAge, type CardKind, type DockEntry, type MockCard, type NewDockEntry, type OrcaThreadRow, type OrchestratorLane } from './ui';
import { SymonVoicePresencePill } from './symon-voice-presence';

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
  packetId?: string | null;
  /** Warm-session key — the transcript fallback when packetId can't resolve. */
  sessionKey?: string | null;
  label?: string | null;
  repoPath?: string | null;
  status?: string | null;
  runtime?: string | null;
  /** Lane creation (ISO) — the agent card's elapsed-timer origin. */
  createdAt?: string | null;
  /** Last write (ISO) — freeze point for a settled agent card's ran-duration. */
  updatedAt?: string | null;
  /** Last event (ISO) — preferred freeze point (the moment work last moved). */
  lastEventAt?: string | null;
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

/** Mini zoom — fixed steps, zoom OUT only. Just breathing room around the
 *  cards, not a camera. 100% is the operator's tuned default view (the look
 *  that used to sit at the old 70% step); 85% and 70% scale OUT from there.
 *  Label and actual CSS-zoom are decoupled — `label` is what the chip reads,
 *  `value` is what `--cnv-zoom` carries for the pointer math. Persisted. */
const ZOOM_KEY = 'o8:canvas-zoom';
/** Canvas layout mode — 'grid' = form-fit hard placement (#1239), else free-flow. */
const GRID_MODE_KEY = 'o8:canvas-grid-mode';
/** Navigator loupe size (#1281) — operator-adjustable via the canvas tuner.
 *  A standalone pref (mirrors ZOOM_KEY/GRID_MODE_KEY) so glass presets don't
 *  resize it. The old hardcoded value was 160. */
const LOUPE_SIZE_KEY = 'o8:canvas-loupe-size';
const LOUPE_SIZE_DEFAULT = 160;
const LOUPE_SIZE_RANGE = { min: 120, max: 240, step: 4 };
// Ordered most-zoomed-IN (index 0) → most-out. "100%" is the home/fit anchor
// (0.7 actual — cards fit comfortably); 115/130 let the operator zoom IN and
// make cards + text bigger (the loupe could previously only go smaller). The
// default + the loupe "Fit" both resolve the label===100 step, NOT index 0.
const ZOOM_STEPS = [
  { label: 130, value: 0.91 },
  { label: 115, value: 0.805 },
  { label: 100, value: 0.7 },
  { label: 85, value: 0.595 },
  { label: 70, value: 0.49 },
] as const;

// ── Canvas control surface (agent parity) ──────────────────────────────────
// Module-scope so the intent listener's deps stay stable. The card verbs let an
// agent drive the canvas the way a human can: SEE every card (list), then move
// / resize / focus / close one by (kind, id).
type CanvasCardKind = 'term' | 'file' | 'image' | 'video' | 'browser' | 'chat' | 'diff' | 'spec' | 'brain' | 'markdown' | 'agent';
const CANVAS_CARD_KINDS: CanvasCardKind[] = ['term', 'file', 'image', 'video', 'browser', 'chat', 'diff', 'spec', 'brain', 'markdown', 'agent'];
const CANVAS_GEOM_FLOOR = 140;
const SPAWN_CHOREOGRAPHY_TTL_MS = 20_000;
// Broad lite shape every card satisfies — enough to list + title + resize
// without reaching for the 11 concrete card types.
type CanvasCardLite = {
  id: number; x: number; y: number; z: number; w: number; h: number;
  sessionName?: string | null; cwd?: string | null; name?: string; path?: string;
  items?: unknown[]; tabs?: Array<{ id: number; url?: string; title?: string }>; activeTabId?: number;
  title?: string; repoPath?: string | null; initialQuestion?: string; codename?: string; number?: number; aspect?: number;
  markdown?: string; diff?: string; truncated?: boolean; threadId?: string; entries?: DockEntry[]; laneId?: string; runtime?: string | null;
  src?: string; mediaId?: string; poster?: string; branch?: string | null; stat?: string; packetId?: string | null;
};
const CANVAS_READ_CAP = 4096;
type SpawnChoreography = { repoPath: string; origin: { x: number; y: number }; delayMs: number; expiresAt: number };
type SpawnReservation = { id: number; x: number; y: number; w: number; h: number };
type CanvasToast = { id: number; message: string; tone: 'error' | 'info' | 'success' };

// Account dossier (the Clerk sign-in popover) — one row vocabulary shared by
// Manage account / Sign out / Sign in, matching the operator's reference.
const DOSSIER_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  paddingTop: 7,
  paddingBottom: 7,
  paddingLeft: 6,
  paddingRight: 8,
  borderRadius: 10,
  borderWidth: 0,
  background: 'transparent',
  cursor: 'pointer',
  fontFamily: FONT,
  fontSize: 12.5,
  fontWeight: 400,
  letterSpacing: '-0.1px',
  color: 'var(--cnv-ink)',
  textAlign: 'left',
  width: '100%',
};
const DOSSIER_TILE: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  flexShrink: 0,
  background: 'var(--cnv-tint)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--cnv-ink-muted)',
};

/** One row in the canvas search dropdown — a card to bring forward, or a
 *  past session to spawn onto the canvas. */
type SearchHit =
  | { kind: 'card'; cardKind: 'term' | 'file' | 'image' | 'browser' | 'chat' | 'diff' | 'spec' | 'brain'; id: number; title: string; meta: string }
  | { kind: 'thread'; threadId: string; repoPath: string | null; repoName: string | null; title: string; meta: string };

// Mirrors COMPOSER_MODEL_OPTIONS in thoughts/InputButtons.tsx (not exported).
const CANVAS_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
];
const CANVAS_ORCA_MODEL_KEY = 'o8:canvas-orca-model';
const CANVAS_ORCA_EFFORT_KEY = 'o8:canvas-orca-effort';
const CANVAS_ORCA_MODE_KEY = 'o8:canvas-orca-mode';
/** First-run welcome modal — set once the operator dismisses the hero. */
const CANVAS_WELCOME_KEY = 'o8:canvas-welcome-seen';
/** Guided coach-mark tour — set once the operator finishes or skips it. */
const CANVAS_TOUR_KEY = 'o8:canvas-tour-seen';

/** How the canvas orchestrator runs a turn — mirrors the default composer's
 *  MODE chip so the operator can keep it from spawning Codex workers at all.
 *   - fleet   — orchestrator dispatches sub-agents in worktrees (default).
 *   - single  — talk to the orchestrator solo, no dispatch.
 *   - fusion  — the deep multi-agent pass we call "ultracode (with Codex)" in
 *               the default composer, renamed here. Backend honoring for fusion
 *               lands later for BOTH surfaces; for now this picks + persists. */
type CanvasMode = 'fleet' | 'single' | 'fusion';
const CANVAS_MODES: Array<{ id: CanvasMode; title: string; detail: string }> = [
  { id: 'fleet', title: 'Fleet orchestration', detail: 'Orchestrator dispatches sub-agents in worktrees.' },
  { id: 'single', title: 'Single agent', detail: 'Talk to the orchestrator solo · no dispatch.' },
  { id: 'fusion', title: 'Fusion', detail: 'Deep multi-agent pass · parallel agents, cross-verified.' },
];

/** Pickers pop out only as tall as the spawn rail (7 glyph buttons) and
 *  centered like it — not the full window height. Mirrors the rail's measured
 *  height; centering uses top:50% + marginTop so framer keeps the transform. */
const RAIL_PANEL_HEIGHT = 296;

/** Dock-matched Lisse panel surface — the dock's solid blur, no border, so a
 *  panel wrapped in <SmoothCorners> reads as the same family as the
 *  orchestrator dock (just thinner). Shared by the Review + Sessions pickers. */
const LISSE_PANEL_SURFACE = {
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: 'var(--cnv-tint-deep)',
  backdropFilter: 'blur(var(--cnv-frost)) saturate(var(--cnv-sat, 1.6))',
  WebkitBackdropFilter: 'blur(var(--cnv-frost)) saturate(var(--cnv-sat, 1.6))',
  boxShadow: '0 14px 42px rgba(0, 0, 0, 0.22)',
  color: 'var(--cnv-ink)',
} as React.CSSProperties;

/** Home-dir agents (#1244): an all-local agent CLI spawned in $HOME as its own
 *  canvas card — no repo, worktree, dispatch, or merge governance. Reuses the
 *  terminal-in-~ PTY path; the chosen `command` is sent to the shell on attach.
 *  opencode is intentionally omitted (experimentalOpencode-gated elsewhere). */
const HOME_AGENTS: { id: string; label: string; command: string }[] = [
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'gemini', label: 'Gemini', command: 'gemini' },
];

export default function CanvasGlassPreviewPage() {
  const canvasEnabled = useExperimentalCanvasFlag();
  const [settings, setSettings] = useState<CanvasGlassSettings>(CANVAS_GLASS_DEFAULTS);
  const [cards, setCards] = useState<MockCard[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [rightRailOpen, setRightRailOpen] = useState(false);
  // Form-fit "hard placement" mode (#1239) — cards pack into a viewport-filling
  // grid. Free-flow is the default. winSize re-grids the layout on resize.
  const [gridMode, setGridMode] = useState(false);
  const [winSize, setWinSize] = useState({ w: 1600, h: 900 });
  // Infinite-canvas pan (#1239 Phase 2) — view offset in canvas px. Free mode
  // only; grid mode resets it to origin and packs to the viewport.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Live mirror of pan for the placement helpers (findFreeSpot / grid), which run
  // off refs so their identity stays stable — reading pan directly would churn
  // every callback that depends on them on each scroll frame.
  const panRef = useRef(pan);
  const panningRef = useRef(false);
  const panTweenRef = useRef<number | null>(null);
  const [composerValue, setComposerValue] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [inTauri, setInTauri] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  // Whether the bottom-center DispatchDock agents tray is expanded (owned here so
  // the grid can re-reserve space for the taller tray — see the re-grid effect).
  const [dockTrayExpanded, setDockTrayExpanded] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [orbSettings, setOrbSettings] = useState<OrbSettings>(ORB_DEFAULTS);
  const [canvasZoomLevel, setCanvasZoomLevel] = useState<number>(ZOOM_STEPS.find((step) => step.label === 100)?.value ?? 0.7);
  const [loupeSize, setLoupeSize] = useState<number>(LOUPE_SIZE_DEFAULT);
  const [personalDefault, setPersonalDefault] = useState<CanvasGlassSettings | null>(null);
  const [activeRepoPath, setActiveRepoPath] = useState<string | null>(null);
  const [composerMenu, setComposerMenu] = useState<'repo' | 'model' | 'mode' | null>(null);
  const [orcaModel, setOrcaModel] = useState(DEFAULT_ORCHESTRATOR_MODEL);
  const [orcaEffort, setOrcaEffort] = useState<ThinkingEffort>('adaptive');
  const [orchMode, setOrchMode] = useState<CanvasMode>('fleet');
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [shareBetaOpen, setShareBetaOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [orcaBusy, setOrcaBusy] = useState(false);
  const [convos, setConvos] = useState<Record<string, DockEntry[]>>({});
  // Live native-Claude scouts (Task-tool fan-out) per lane — surfaced in the
  // dock's crew card while the turn runs, cleared when it settles. Without this
  // the scouts vanish into the collapsed "N actions" tool cluster.
  const [liveScouts, setLiveScouts] = useState<Record<string, SwarmScoutView[]>>({});
  const [termCards, setTermCards] = useState<TermCard[]>([]);
  const [fileCards, setFileCards] = useState<FileCard[]>([]);
  const [imageCards, setImageCards] = useState<ImageCard[]>([]);
  // Which card the dragged photo is currently hovering over (→ would stack).
  // Drives the "Drop to stack" highlight. A ref mirror of imageCards lets the
  // move handler hit-test against the other cards without a stale closure.
  const [dropTargetId, setDropTargetId] = useState<number | null>(null);
  const imageCardsRef = useRef<ImageCard[]>([]);
  imageCardsRef.current = imageCards;
  const [videoCards, setVideoCards] = useState<VideoCard[]>([]);
  const [termVeil, setTermVeil] = useState(TERM_VEIL_DEFAULT);
  const [termPickerOpen, setTermPickerOpen] = useState(false);
  const [filePathPickerOpen, setFilePathPickerOpen] = useState(false);
  const [filePathInput, setFilePathInput] = useState('');
  const [filePickerBusy, setFilePickerBusy] = useState(false);
  const [canvasToast, setCanvasToast] = useState<CanvasToast | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessionsRepoFilter, setSessionsRepoFilter] = useState<string | null>(null);
  const [composerImages, setComposerImages] = useState<Array<{ name: string; dataUri: string }>>([]);
  const [diffCards, setDiffCards] = useState<DiffCard[]>([]);
  const [specCards, setSpecCards] = useState<SpecCard[]>([]);
  const [brainCards, setBrainCards] = useState<BrainCard[]>([]);
  // Render-on-screen (#1270) — markdown explainer cards the orchestrator paints
  // via the `render` intent. Content IS the card, so snapshot it with geometry.
  const [markdownCards, setMarkdownCards] = useState<MarkdownCard[]>([]);
  const [agentCards, setAgentCards] = useState<AgentCard[]>([]);
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [browserCards, setBrowserCards] = useState<BrowserCard[]>([]);
  const [chatCards, setChatCards] = useState<ChatCard[]>([]);
  const [topMenu, setTopMenu] = useState<'alerts' | 'agents' | 'profile' | null>(null);
  const [inboxItems, setInboxItems] = useState<InboxRow[]>([]);
  // Which alerts the operator has already clicked — dims the row + drops it
  // from the bell's unseen count. Persisted so a reload doesn't re-surface
  // what you've acted on.
  const [seenAlerts, setSeenAlerts] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = window.localStorage.getItem('o8:canvas-alerts-seen');
      const arr = raw ? JSON.parse(raw) : [];
      return new Set<string>(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  });
  const [activeLanes, setActiveLanes] = useState<LaneRow[]>([]);
  const [recentThreads, setRecentThreads] = useState<OrcaThreadRow[]>([]);
  const [recentCommits, setRecentCommits] = useState<CommitRow[]>([]);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Shared identity hook (Clerk) — safe even with no keys: returns a disabled,
  // signed-out state, so the account control degrades to a "Sign in" door.
  const auth = useO8Auth();
  // Push-to-talk for the primary stage composer — speak instead of type, same
  // engine as the default IDE. Speech lands via a functional setState so it
  // appends to whatever is already drafted (no stale snapshot).
  const dictationHost = useDictationHostOptional();
  const registerComposerDictation = useCallback(() => {
    const node = composerInputRef.current;
    if (!node || !dictationHost) return;
    dictationHost.setActiveComposer({
      node,
      fill: (text: string) => setComposerValue((current) => (current.trim() ? `${current.trim()} ${text}` : text)),
    });
  }, [dictationHost]);
  const reduceMotion = useReducedMotion() ?? false;
  // Right-Option agent dictation morphs the composer in place — its controls
  // fade out and the live partial words stream where you'd type, growing the
  // pill upward like the outside HUD. Latch + HUD-yield claim live in the hook;
  // `canClaim` only lets the canvas own the partials when its composer is truly
  // on screen + the window is focused (else the outside HUD keeps painting).
  const partialsMorph = useAgentPartialsMorph(() => {
    if (!canvasEnabled) return false;
    if (typeof document === 'undefined') return false;
    if (document.visibilityState !== 'visible') return false;
    if (!document.hasFocus()) return false;
    // offsetParent === null ⇒ the composer is display:none / a backgrounded tab.
    if (composerInputRef.current && composerInputRef.current.offsetParent === null) return false;
    return true;
  });
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
  const symonSpawnPacketIdsRef = useRef(new Set<string>());
  const symonSpawnWindowUntilRef = useRef(0);
  const spokenSymonLaneIdsRef = useRef(new Set<string>());
  const announcedSymonLaneIdsRef = useRef(new Set<string>());
  const dataSeenRef = useRef(new Set<string>());
  // First spawn of the visit gets the full reveal (min-play); the rest
  // bail the instant the shell answers — speed stays the default.
  const firstSpawnRef = useRef(true);
  // Terminals + file cards share one z band (10–39, chrome at 40+) so
  // clicking ANY card brings it above every other card kind.
  const zPeakRef = useRef(9);
  // Agent-card bloom: lanes already carded (so a lane blooms exactly once), the
  // monotonic address number ("agent two"). Dedupe-by-laneId: a lane is only ever
  // carded once. Entering the canvas cards ALL currently-running lanes (fleet
  // dispatched from the IDE/MCP while the canvas was closed), not just lanes born
  // after entry — the dedupe set keeps a re-card from ever double-blooming.
  const cardedLaneIdsRef = useRef<Set<string>>(new Set());
  const agentNumberRef = useRef(1);
  // Where the last agent card (overall + per-repo) landed — the preferred anchor
  // so a fresh sibling clusters NEAR its group instead of scattering.
  const agentAnchorsRef = useRef<{ last: { x: number; y: number } | null; byRepo: Map<string, { x: number; y: number }> }>({ last: null, byRepo: new Map() });
  const mountedCardIdsRef = useRef<Set<number>>(new Set());
  const spawnChoreographyRef = useRef<SpawnChoreography[]>([]);
  const spawnReservationsRef = useRef<SpawnReservation[]>([]);
  const canvasToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      // First-attach steering (one-shot per session). Today's bundled ws-server
      // ignores the create-payload cwd, so we cd the fresh shell here; once the
      // server-side cwd ships, the pty already starts there and this is a no-op.
      if (cdSentRef.current.has(sessionName)) return;
      const card = termCards.find((existing) => existing.sessionName === sessionName);
      if (!card) return;
      cdSentRef.current.add(sessionName);
      if (card.cwd) {
        const escaped = card.cwd.replace(/'/g, `'\\''`);
        sendTerminalInput(sessionName, `cd '${escaped}' && clear\n`);
      }
      // Home agent (#1244): auto-launch the chosen local agent CLI — an
      // all-local agent in the home dir (cwd null → PTY's HOME default), no
      // repo/worktree. `agentCli` is the command (claude | codex | gemini).
      if (card.agentCli) {
        sendTerminalInput(sessionName, `${card.agentCli}\n`);
      }
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

  // Free canvas is Paper-only, light or dark (operator, 2026-07-06) — founders
  // get every look + dial. null = entitlement not resolved yet (panel renders
  // full, enforcement waits; the clamp lands the moment free resolves).
  const [foundersGlass, setFoundersGlass] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/panel/entitlement', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        const plan = data?.plan;
        const isFounders = Boolean(data?.founder) || plan === 'founder' || plan === 'pro' || plan === 'team';
        setFoundersGlass(isFounders);
        if (!isFounders) {
          // Clamp whatever was stored to the nearest free look — Paper
          // light/dark or Glass — so a saved Glass survives relaunch.
          const stored = readCanvasGlassSettings();
          const clamped = canvasFreeLook(canvasFreeLookIdFor(stored));
          setSettings(clamped);
          writeCanvasGlassSettings(clamped);
          applyCanvasGlassSettings(clamped);
          void setCanvasMaterial(clamped.material);
          void setCanvasBackdropBlur(clamped.backdropFrost);
        }
      })
      .catch(() => { if (alive) setFoundersGlass(true); /* fail-open visually; API gate is authoritative */ });
    return () => { alive = false; };
  }, []);

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
      const storedMode = window.localStorage.getItem(CANVAS_ORCA_MODE_KEY);
      if (storedMode === 'fleet' || storedMode === 'single' || storedMode === 'fusion') setOrchMode(storedMode);
      // First-run welcome — springs in over a frosted canvas until dismissed.
      if (window.localStorage.getItem(CANVAS_WELCOME_KEY) !== '1') setWelcomeOpen(true);
      const storedZoom = Number.parseFloat(window.localStorage.getItem(ZOOM_KEY) ?? '');
      if (ZOOM_STEPS.some((step) => step.value === storedZoom)) setCanvasZoomLevel(storedZoom);
      const storedLoupe = Number.parseFloat(window.localStorage.getItem(LOUPE_SIZE_KEY) ?? '');
      if (Number.isFinite(storedLoupe) && storedLoupe >= LOUPE_SIZE_RANGE.min && storedLoupe <= LOUPE_SIZE_RANGE.max) setLoupeSize(storedLoupe);
      // Image cards restore through the canvas snapshot (loadCanvasSnapshot)
      // like every other card kind — NOT through a second store here. Loading
      // them in both places spawned a perfect-overlap duplicate that only
      // showed when you dragged one off the other.
    } catch {
      // defaults stand
    }
  }, []);

  // DEV — quick re-open while iterating on dev-bridge (the real entry is the end
  // of the welcome tour, wired below): window.__o8OpenShareBeta(). Strip at ship.
  useEffect(() => {
    (window as unknown as { __o8OpenShareBeta?: () => void }).__o8OpenShareBeta = () => setShareBetaOpen(true);
    return () => { delete (window as unknown as { __o8OpenShareBeta?: () => void }).__o8OpenShareBeta; };
  }, []);

  // Stamp + persist the zoom — drag handlers read --cnv-zoom for their
  // pointer math, so the stamp must land before any drag at this level.
  useEffect(() => {
    document.documentElement.style.setProperty('--cnv-zoom', String(canvasZoomLevel));
    try {
      window.localStorage.setItem(ZOOM_KEY, String(canvasZoomLevel));
    } catch {
      // non-critical
    }
  }, [canvasZoomLevel]);

  useEffect(() => () => {
    if (canvasToastTimerRef.current) clearTimeout(canvasToastTimerRef.current);
  }, []);

  // Persist the operator-adjustable navigator loupe size (#1281).
  useEffect(() => {
    try {
      window.localStorage.setItem(LOUPE_SIZE_KEY, String(loupeSize));
    } catch {
      // non-critical
    }
  }, [loupeSize]);

  // Keep the pan mirror fresh for the ref-based placement helpers.
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  // Kill the text-selection "highlight" a drag leaves behind: dragging the
  // navigator ball / a card / panning the canvas paints a selection across the
  // whole screen. The canvas is user-select:none by design, but WebKit still
  // lets a drag that STARTS on a non-selectable surface extend a selection over
  // the page. Suppress selectstart everywhere EXCEPT real text entry (composer,
  // CodeMirror, inputs) so dragging never highlights while typing still selects.
  useEffect(() => {
    const onSelectStart = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      event.preventDefault();
    };
    document.addEventListener('selectstart', onSelectStart);
    return () => document.removeEventListener('selectstart', onSelectStart);
  }, []);

  // Stamp the right-dock reserve (screen px it eats) on the same channel as
  // --cnv-zoom, so drag-boundary resistance keeps cards clear of the dock.
  // 0 when closed; 424 = dock.tsx right:24 + width:400.
  useEffect(() => {
    document.documentElement.style.setProperty('--cnv-dock-reserve', dockOpen ? '424' : '0');
  }, [dockOpen]);

  // Escape closes every ephemeral layer — popovers, pickers, drawers,
  // search. They all have outside-click veils; this is the keyboard peer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setTopMenu(null);
      setComposerMenu(null);
      setTermPickerOpen(false);
      setFilePathPickerOpen(false);
      setReviewPickerOpen(false);
      setSessionsOpen(false);
      setSearchOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ⌘= / ⌘+ zoom IN · ⌘- / ⌘_ zoom OUT · ⌘0 reset to 100% — the keyboard peer of
  // the loupe's −/fit/+ cluster. Steps the SAME ZOOM_STEPS array through the same
  // setCanvasZoomLevel the loupe's onZoomChange drives (index −1 = more zoomed in
  // = bigger cards + text, +1 = more out), so every path lands on the identical
  // discrete rungs. preventDefault stops WebKit's native page zoom, which would
  // scale the whole chrome instead of only the canvas layer. Never fires while
  // typing — a focused input / textarea / CodeMirror editor keeps ⌘-/⌘= for
  // itself so the file-card editor is untouched.
  useEffect(() => {
    const onZoomKey = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      const stepZoom = (delta: number) => {
        setCanvasZoomLevel((current) => {
          const idx = Math.max(0, ZOOM_STEPS.findIndex((step) => step.value === current));
          const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, idx + delta))];
          return next ? next.value : current;
        });
      };
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        stepZoom(-1);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        stepZoom(1);
      } else if (event.key === '0') {
        event.preventDefault();
        setCanvasZoomLevel(ZOOM_STEPS.find((step) => step.label === 100)?.value ?? 0.7);
      }
    };
    window.addEventListener('keydown', onZoomKey);
    return () => window.removeEventListener('keydown', onZoomKey);
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

  /** One lanes refetch used by the poll, the Review drawer, and the live
   *  lane-lifecycle push — agent spawns/review-ready land in real time. */
  const refreshLanes = useCallback(() => {
    fetch('/api/lanes?active=true')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { lanes?: LaneRow[] } | null) => {
        if (data && Array.isArray(data.lanes)) setActiveLanes(data.lanes);
      })
      .catch(() => {});
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
      refreshLanes();
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
  }, [refreshLanes]);

  // Opening the Sessions popover (or the search, which lists sessions too)
  // refetches so the list is never two minutes stale.
  useEffect(() => {
    if (!sessionsOpen && !searchOpen) return;
    let disposed = false;
    fetch('/api/mobile/orchestrator/threads')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { threads?: OrcaThreadRow[] } | null) => {
        if (!disposed && data && Array.isArray(data.threads)) setRecentThreads(data.threads);
      })
      .catch(() => {});
    return () => { disposed = true; };
  }, [searchOpen, sessionsOpen]);

  // Same for the Review drawer — lanes move fast, the list must be live.
  useEffect(() => {
    if (reviewPickerOpen) refreshLanes();
  }, [refreshLanes, reviewPickerOpen]);

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

  // Orb refraction dials — scoped per canvas tone (glass reads differently on a
  // light vs dark backdrop), persisted, and applied to the WebGL ball live.
  useEffect(() => {
    setOrbSettings(readOrbSettings(settings.tone));
  }, [settings.tone]);
  const updateOrbSettings = useCallback((patch: Partial<OrbSettings>) => {
    setOrbSettings((previous) => {
      const next = { ...previous, ...patch };
      writeOrbSettings(settings.tone, next);
      return next;
    });
  }, [settings.tone]);
  const resetOrbSettings = useCallback(() => {
    writeOrbSettings(settings.tone, ORB_DEFAULTS);
    setOrbSettings({ ...ORB_DEFAULTS });
  }, [settings.tone]);

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
      return { ...previous, [lane]: [...(previous[lane] ?? []), ...next] };
    });
  }, []);

  const resolveStatus = useCallback((lane: string, text: string) => {
    setConvos((previous) => ({
      ...previous,
      [lane]: (previous[lane] ?? []).map((entry) => {
        // The turn settling also settles any live reasoning stream.
        if (entry.role === 'thinking' && entry.live) return { ...entry, live: false };
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
        [lane]: [...entries, { role: 'status', text: name, pending: true, kind: 'tool', count: 1, id }],
      };
    });
  }, []);

  /** The full assistant answer for the in-flight turn, per lane — fed to the
   *  end-of-turn playback bar so it can speak "the entire thing he said." */
  const turnTextRef = useRef(new Map<string, string>());

  /** Real orchestrator deltas grow the last live text entry in place.
   *  A text delta also settles any live reasoning stream above it. */
  const appendAssistantDelta = useCallback((lane: string, delta: string) => {
    turnTextRef.current.set(lane, (turnTextRef.current.get(lane) ?? '') + delta);
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
      const settled = entries.map((entry) => (entry.role === 'thinking' && entry.live ? { ...entry, live: false } : entry));
      return { ...previous, [lane]: [...settled, { role: 'text', text: delta, live: true, id }] };
    });
  }, []);

  /** Reasoning deltas — the model thinking out loud, rendered as a staged
   *  timeline (Q's reference). Paragraph boundaries stamp REAL elapsed
   *  marks so each stage carries its own time chip. */
  const appendThinkingDelta = useCallback((lane: string, delta: string) => {
    setConvos((previous) => {
      const entries = previous[lane] ?? [];
      const last = entries[entries.length - 1];
      if (last && last.role === 'thinking' && last.live) {
        const text = last.text + delta;
        const previousStages = last.text.split(/\n\s*\n/).length;
        const stages = text.split(/\n\s*\n/).length;
        const startedAt = last.startedAt ?? Date.now();
        const marks = stages > previousStages
          ? [...(last.marks ?? []), Math.round((Date.now() - startedAt) / 1000)]
          : last.marks;
        const updated = [...entries];
        updated[updated.length - 1] = { ...last, text, marks };
        return { ...previous, [lane]: updated };
      }
      const id = entryIdRef.current;
      entryIdRef.current += 1;
      return { ...previous, [lane]: [...entries, { role: 'thinking', text: delta, live: true, startedAt: Date.now(), marks: [], id }] };
    });
  }, []);

  /** ONE event pipeline for every live line — the dock's repo-keyed convo
   *  AND each chat card's thread-keyed convo flow through here. */
  // One result-card accumulator per lane — collects the turn's edits / PR and
  // rolls them into result entries when the turn settles (status 'ready').
  const turnToolsRef = useRef(new Map<string, TurnTools>());
  const ensureTurnTools = useCallback((lane: string): TurnTools => {
    let acc = turnToolsRef.current.get(lane);
    if (!acc) { acc = emptyTurnTools(); turnToolsRef.current.set(lane, acc); }
    return acc;
  }, []);

  const handleOrcaEvent = useCallback((lane: string, event: OrcaThreadEvent): void => {
    if (event.type === 'output') {
      if (!firstOutputRef.current.has(lane)) {
        firstOutputRef.current.add(lane);
        resolveStatus(lane, 'Working');
      }
      if (event.thinking) {
        appendThinkingDelta(lane, event.text);
        return;
      }
      appendAssistantDelta(lane, event.text);
    } else if (event.type === 'tool') {
      if (!firstOutputRef.current.has(lane)) {
        firstOutputRef.current.add(lane);
        resolveStatus(lane, 'Working');
      }
      // Fold the edit into the turn's result accumulator (→ a rolled-up
      // "Edited N files" card at turn end), then surface the live activity line.
      recordTool(ensureTurnTools(lane), event.name, event.args);
      noteToolUse(lane, event.name);
      // Native Claude scouts (Task-tool sub-agents) — surface them as a live
      // crew instead of letting them disappear into the tool-count cluster.
      if (event.name === 'Task' || event.name.toLowerCase() === 'task') {
        const args = event.args ?? {};
        const description = typeof args.description === 'string' ? args.description.trim() : '';
        const subagentType = typeof args.subagent_type === 'string' ? args.subagent_type.trim() : '';
        setLiveScouts((previous) => {
          const existing = previous[lane] ?? [];
          const label = description || subagentType || `Scout ${existing.length + 1}`;
          return { ...previous, [lane]: [...existing, { id: `${lane}-scout-${existing.length}`, label, status: 'running' }] };
        });
      }
    } else if (event.type === 'tool-result') {
      // Only `gh pr create` output matters (the PR card). MUST stay above the
      // `else` — that reads event.error, which a tool-result lacks (would throw).
      recordToolResult(ensureTurnTools(lane), event.name, event.args, event.output);
    } else if (event.type === 'status') {
      if (event.status === 'dead') {
        turnToolsRef.current.delete(lane);
        turnTextRef.current.delete(lane);
        setLiveScouts((previous) => ({ ...previous, [lane]: [] }));
        resolveStatus(lane, 'Session ended');
      } else if (event.status === 'ready') {
        // Roll the turn's edits / PR / captured screenshots into result cards.
        const acc = turnToolsRef.current.get(lane);
        const toAppend: NewDockEntry[] = acc ? synthesizeResultEntries(acc) : [];
        // …then a playback bar at the very end, carrying the full answer so the
        // operator can hear the whole turn read back (Symon voice).
        const said = (turnTextRef.current.get(lane) ?? '').trim();
        turnTextRef.current.delete(lane);
        if (said) toAppend.push({ role: 'playback', text: said });
        if (toAppend.length) appendEntries(lane, toAppend);
        turnToolsRef.current.delete(lane);
        setLiveScouts((previous) => ({ ...previous, [lane]: [] }));
        resolveStatus(lane, 'Done');
      }
    } else {
      resolveStatus(lane, 'Failed');
      appendEntries(lane, [{ role: 'status', text: event.error.slice(0, 200), pending: false }]);
    }
  }, [appendAssistantDelta, appendEntries, appendThinkingDelta, ensureTurnTools, noteToolUse, resolveStatus]);

  // The REAL orchestrator — same ws-server channel the OrchestratorTab
  // speaks, scoped to the composer's repo. Convos are keyed by repo path.
  const orca = useCanvasOrchestrator(activeRepoPath, {
    onOutput: (repo, text, thinking) => {
      if (!firstOutputRef.current.has(repo)) setDockOpen(true);
      handleOrcaEvent(repo, { type: 'output', text, thinking });
    },
    onToolUse: (repo, name, args) => {
      if (!firstOutputRef.current.has(repo)) setDockOpen(true);
      handleOrcaEvent(repo, { type: 'tool', name, args });
    },
    onToolResult: (repo, name, args, output) => {
      handleOrcaEvent(repo, { type: 'tool-result', name, args, output });
    },
    onStatus: (repo, status) => {
      setOrcaBusy(status === 'busy');
      handleOrcaEvent(repo, { type: 'status', status });
    },
    onError: (repo, error) => {
      handleOrcaEvent(repo, { type: 'error', error });
    },
    onLaneLifecycle: refreshLanes,
  });

  // The dock survives reloads like the cards do — an empty lane whose repo
  // has a persisted thread re-seeds its transcript from chat history (the
  // same source pickThread uses for floating cards).
  const dockSeededRef = useRef(new Set<string>());
  useEffect(() => {
    if (!dockOpen || !activeRepoPath) return;
    const repo = activeRepoPath;
    if ((convos[repo]?.length ?? 0) > 0) return;
    const threadId = orca.threadIdFor(repo);
    if (!threadId || dockSeededRef.current.has(threadId)) return;
    dockSeededRef.current.add(threadId);
    void fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { messages?: Array<{ role?: string; content?: string }> } | null) => {
        const messages = Array.isArray(data?.messages) ? data.messages : [];
        if (!messages.length) return;
        const entries: DockEntry[] = [];
        for (const message of messages) {
          const text = typeof message.content === 'string' ? message.content.trim() : '';
          if (!text) continue;
          const id = entryIdRef.current;
          entryIdRef.current += 1;
          entries.push(message.role === 'user' ? { role: 'user', text, id } : { role: 'text', text, id });
        }
        // A turn that started while we fetched wins the lane.
        setConvos((previous) => ((previous[repo]?.length ?? 0) > 0 ? previous : { ...previous, [repo]: entries }));
      })
      .catch(() => {});
  }, [dockOpen, activeRepoPath, convos, orca]);

  /** Erase a lane's transcript back to a boundary — powers undo-send
   *  (everything at/after the just-sent user entry vanishes, like it never was). */
  const truncateLane = useCallback((lane: string, fromEntryId: number) => {
    setConvos((previous) => ({
      ...previous,
      [lane]: (previous[lane] ?? []).filter((entry) => entry.id < fromEntryId),
    }));
  }, []);

  /** The raw send for the docked / bottom conversation — fires the turn,
   *  appends the user entry, and returns the undo-truncation boundary (or null
   *  if it never went out). */
  const dispatchMain = useCallback((text: string, images: ComposerImage[]) => {
    const lane = activeRepoPath;
    if (!lane) return null;
    firstOutputRef.current.delete(lane);
    const threadId = orca.send(text, {
      model: orcaModel,
      thinkingEffort: orcaEffort,
      ...(images.length ? { attachments: images } : {}),
    });
    const fromEntryId = entryIdRef.current;
    const userEntry = {
      role: 'user' as const,
      text,
      ...(images.length ? { images: images.map((image) => image.dataUri) } : {}),
    };
    if (!threadId) {
      appendEntries(lane, [userEntry, { role: 'status', text: 'Not connected yet — try again in a second', pending: false }]);
      setDockOpen(true);
      return null;
    }
    // The bottom composer and the dock are one view of this lane. If it's
    // currently floating as an undocked card, adopt the card's thread lane (the
    // complete record, incl. turns typed in the card) onto the dock lane BEFORE
    // appending this turn, then fold the card away — never two views at once.
    const tId = orca.threadIdFor(lane);
    if (tId) {
      setConvos((previous) => (previous[`thread:${tId}`] ? { ...previous, [lane]: previous[`thread:${tId}`] } : previous));
      setChatCards((previous) => previous.filter((card) => card.threadId !== tId));
    }
    appendEntries(lane, [userEntry, { role: 'status', text: 'Thinking', pending: true }]);
    setDockOpen(true);
    return { lane, fromEntryId };
  }, [activeRepoPath, appendEntries, orca, orcaEffort, orcaModel]);

  // Mistake-proofing for the main conversation (bottom pill + dock): undo-send
  // grace buffer + queue-when-busy. Both composers route through `mainSend`.
  const {
    send: mainSend,
    stopOrUndo: mainStopOrUndo,
    undoArmed: mainUndoArmed,
    queued: mainQueued,
    cancelQueued: mainCancelQueued,
  } = useSendBuffer({
    busy: orcaBusy,
    dispatch: dispatchMain,
    interrupt: orca.interrupt,
    restore: (text, images) => {
      setComposerValue(text);
      setComposerImages(images);
      composerInputRef.current?.focus();
    },
    truncate: truncateLane,
  });

  /** One send path for every main-conversation composer — the bottom pill AND
   *  the dock's own reply input. Queues when busy; arms undo when it goes out. */
  const sendPrompt = useCallback((prompt: string, attachments?: Array<{ dataUri: string; name?: string }>): boolean => {
    const images: ComposerImage[] = (attachments ?? []).map((attachment) => ({ name: attachment.name ?? 'image', dataUri: attachment.dataUri }));
    return mainSend(prompt, images);
  }, [mainSend]);

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
    // Drawer stays open — the merged picker lets you set model AND thinking in
    // one visit; the backdrop click dismisses it.
    try {
      window.localStorage.setItem(CANVAS_ORCA_MODEL_KEY, value);
    } catch {
      // non-critical
    }
  }, []);

  const chooseEffort = useCallback((value: ThinkingEffort) => {
    setOrcaEffort(value);
    // Stays open (see chooseModel) — set model + thinking, then click away.
    try {
      window.localStorage.setItem(CANVAS_ORCA_EFFORT_KEY, value);
    } catch {
      // non-critical
    }
  }, []);

  const chooseMode = useCallback((value: CanvasMode) => {
    setOrchMode(value);
    setComposerMenu(null);
    try {
      window.localStorage.setItem(CANVAS_ORCA_MODE_KEY, value);
    } catch {
      // non-critical
    }
  }, []);

  const closeWelcome = useCallback(() => {
    setWelcomeOpen(false);
    try {
      window.localStorage.setItem(CANVAS_WELCOME_KEY, '1');
    } catch {
      // non-critical
    }
  }, []);

  // Start the journey — dismiss the hero, then run the guided tour (unless it's
  // already been seen). Skipping the hero (✕/Esc) takes closeWelcome instead.
  const startFromWelcome = useCallback(() => {
    closeWelcome();
    let seen = false;
    try { seen = window.localStorage.getItem(CANVAS_TOUR_KEY) === '1'; } catch { /* default unseen */ }
    if (!seen) setTourOpen(true);
  }, [closeWelcome]);

  const closeTour = useCallback(() => {
    setTourOpen(false);
    try {
      window.localStorage.setItem(CANVAS_TOUR_KEY, '1');
    } catch {
      // non-critical
    }
  }, []);

  /** A PAST session opens as its OWN draggable glass box — the dock stays
   *  reserved for the docked live orchestrator. The card's dock glyph
   *  promotes it into the dock if wanted. */
  // ── Spawn placement — new cards land on open canvas, not on each other.
  // A ref mirror keeps the finder stable (no per-mutation callback churn).
  const cardRectsRef = useRef<Array<{ x: number; y: number; w: number; h: number }>>([]);
  useEffect(() => {
    const ids = [
      ...cards.map((card) => card.id),
      ...termCards.map((card) => card.id),
      ...fileCards.map((card) => card.id),
      ...imageCards.map((card) => card.id),
      ...videoCards.map((card) => card.id),
      ...browserCards.map((card) => card.id),
      ...chatCards.map((card) => card.id),
      ...diffCards.map((card) => card.id),
      ...specCards.map((card) => card.id),
      ...brainCards.map((card) => card.id),
      ...markdownCards.map((card) => card.id),
      ...agentCards.map((card) => card.id),
    ];
    const reduce = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const id of ids) {
      if (mountedCardIdsRef.current.has(id)) continue;
      mountedCardIdsRef.current.add(id);
      window.requestAnimationFrame(() => {
        const el = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement | null;
        if (!el) return;
        const animation = reduce
          ? `cnv-card-fade-in ${CARD_ENTRANCE.reducedMs}ms ease both`
          : `cnv-card-enter ${CARD_ENTRANCE.enterMs}ms ${CARD_ENTRANCE.ease} both, cnv-card-border-draw ${CARD_ENTRANCE.borderMs}ms ease-out both`;
        const token = `${id}:${Date.now()}`;
        el.setAttribute('data-cnv-entrance', token);
        el.style.animation = animation;
        el.style.transformOrigin = 'center center';
        window.setTimeout(() => {
          if (el.getAttribute('data-cnv-entrance') !== token) return;
          el.style.animation = '';
          el.style.transformOrigin = '';
          el.removeAttribute('data-cnv-entrance');
        }, reduce ? CARD_ENTRANCE.reducedMs + 20 : CARD_ENTRANCE.borderMs + 20);
      });
    }
  }, [agentCards, brainCards, browserCards, cards, chatCards, diffCards, fileCards, imageCards, markdownCards, specCards, termCards, videoCards]);

  useEffect(() => {
    cardRectsRef.current = [
      ...termCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
      ...fileCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
      ...imageCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 28 })),
      ...browserCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 92 })),
      ...chatCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
      ...diffCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
      ...specCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
      ...brainCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 92 })),
      ...markdownCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
      ...agentCards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h + 36 })),
    ];
  }, [termCards, fileCards, imageCards, browserCards, chatCards, diffCards, specCards, brainCards, markdownCards, agentCards]);

  /** Nearest clear spot to an anchor (the viewport centre by default, or a caller
   *  -supplied cluster origin) inside the VISIBLE viewport — least-covered cell
   *  when the field is genuinely full. Reading-order first-fit used to let each
   *  new card drift down-and-right until a session read "scattered everywhere";
   *  gathering around the anchor keeps a working session visually together.
   *  Existing floating chrome (composer, dispatch dock, review picker, right
   *  dock) is treated as occupied, so a card never spawns under it. `anchor` is
   *  optional (canvas px) — the agent-card cluster passes its own. */
  const findFreeSpot = useCallback((w: number, h: number, anchor?: { x: number; y: number } | null): { x: number; y: number } => {
    const z = canvasZoom();
    const p = panRef.current;
    const taken = [
      ...cardRectsRef.current,
      ...spawnReservationsRef.current,
      ...chromeRectsCanvas(p, z),
    ];
    const pad = 18;
    // Visible viewport in canvas px (screen 0,0,w,h → canvas via (screen − pan)/z).
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    const viewX = -p.x / z;
    const viewY = -p.y / z;
    const minX = viewX + 96 / z; // clear the left spawn rail
    const minY = viewY + 84 / z; // clear the top control pill
    const maxX = Math.max(minX, viewX + (vw - 24) / z - w);
    const maxY = Math.max(minY, viewY + (vh - 96) / z - Math.min(h, 360));
    // Anchor the search: caller cluster origin, else the viewport centre.
    const anchorX = anchor ? anchor.x : viewX + vw / z / 2;
    const anchorY = anchor ? anchor.y : viewY + vh / z / 2;
    let free: { x: number; y: number } | null = null;
    let freeDist = Infinity;
    let best = { x: minX, y: minY };
    let bestOverlap = Infinity;
    const nearestFree: { x: number; y: number } | null = null;
    const nearestDist = Infinity;
    for (let y = minY; y <= maxY; y += 56) {
      for (let x = minX; x <= maxX; x += 64) {
        let overlap = 0;
        for (const rect of taken) {
          const ox = Math.max(0, Math.min(x + w, rect.x + rect.w + pad) - Math.max(x, rect.x - pad));
          const oy = Math.max(0, Math.min(y + h, rect.y + rect.h + pad) - Math.max(y, rect.y - pad));
          overlap += ox * oy;
        }
        if (overlap === 0) {
          // Distance from the candidate CENTRE to the anchor — nearest wins.
          const dx = x + w / 2 - anchorX;
          const dy = y + h / 2 - anchorY;
          const dist = dx * dx + dy * dy;
          if (dist < freeDist) { freeDist = dist; free = { x, y }; }
        } else if (overlap < bestOverlap) {
          bestOverlap = overlap;
          best = { x, y };
        }
      }
    }
    return free ?? best;
  }, []);

  const pickThread = useCallback((threadId: string, repoPath: string | null, meta?: { title?: string | null; repoName?: string | null }, at?: SnapGeometry) => {
    return fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(threadId)}`)
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
        const spot = at ?? findFreeSpot(380, 400);
        // The card's live convo lane starts from the history transcript —
        // its in-card composer streams onto the same lane from there.
        setConvos((previous) => ({ ...previous, [`thread:${threadId}`]: entries }));
        setChatCards((previous) => [...previous, {
          id,
          threadId,
          repoPath: repoPath ?? data?.repoPath ?? null,
          repoName: meta?.repoName ?? data?.repoName ?? null,
          title: meta?.title?.trim() || data?.title?.trim() || (typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 60) : 'Past session'),
          x: spot.x,
          y: spot.y,
          z: zPeakRef.current,
          w: at?.w ?? 380,
          h: at?.h ?? 400,
          entries,
        }]);
      })
      .catch(() => {});
  }, [findFreeSpot]);

  /** A chat card's own composer went out — append the turn to its lane.
   *  Mirrors sendPrompt's entry shapes; the card already did the ws send. */
  const noteCardSend = useCallback((card: ChatCard, text: string, sent: boolean): number => {
    const lane = `thread:${card.threadId}`;
    firstOutputRef.current.delete(lane);
    const fromEntryId = entryIdRef.current;
    appendEntries(lane, sent
      ? [{ role: 'user', text }, { role: 'status', text: 'Thinking', pending: true }]
      : [{ role: 'user', text }, { role: 'status', text: 'Not connected yet — try again in a second', pending: false }]);
    return fromEntryId;
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

  /** Undock the live orchestrator back onto the canvas as a floating chat card
   *  — the exact inverse of dockChatCard. The conversation KEEPS rendering
   *  (the bug was that undock hid the transcript entirely: dockOpen=false with
   *  nothing below it). The lane stays live the whole time — the `orca` socket
   *  never unsubscribes from activeRepoPath — so convos[repo] is the source and
   *  the card's own thread socket picks up exactly where the dock left off. The
   *  same dock button folds it back in via redockActiveLane. */
  const undockToCard = useCallback(() => {
    const repo = activeRepoPath;
    if (!repo) { setDockOpen(false); return; }
    const threadId = orca.threadIdFor(repo);
    const entries = convos[repo] ?? [];
    // No thread yet / empty lane — nothing conversable to float; just hide.
    if (!threadId || entries.length === 0) { setDockOpen(false); return; }
    // Already on the canvas as a card — don't spawn a duplicate, just hide.
    if (chatCards.some((card) => card.threadId === threadId)) { setDockOpen(false); return; }
    const name = repos?.find((r) => r.path === repo)?.name ?? null;
    const firstUser = entries.find((entry) => entry.role === 'user');
    const title = firstUser && firstUser.role === 'user' && firstUser.text.trim()
      ? firstUser.text.trim().slice(0, 60)
      : (name ?? 'Orchestrator');
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(380, 400);
    // Seed the card's live lane from the dock lane so its transcript is there
    // on first paint and its socket streams onto the same conversation.
    setConvos((previous) => ({ ...previous, [`thread:${threadId}`]: previous[repo] ?? entries }));
    setChatCards((previous) => [...previous, {
      id,
      threadId,
      repoPath: repo,
      repoName: name,
      title,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 380,
      h: 400,
      entries,
    }]);
    setDockOpen(false);
  }, [activeRepoPath, convos, orca, repos, chatCards, findFreeSpot]);

  /** Re-dock the active lane — if it's floating as a card, fold that exact card
   *  back in via dockChatCard (which adopts the card's thread lane, the complete
   *  record incl. anything typed in the card, back onto the dock). Otherwise
   *  just open the dock on the active lane. */
  const redockActiveLane = useCallback(() => {
    const repo = activeRepoPath;
    const threadId = repo ? orca.threadIdFor(repo) : null;
    if (repo && threadId) {
      const card = chatCards.find((existing) => existing.threadId === threadId);
      if (card) { dockChatCard(card); return; }
    }
    setDockOpen(true);
  }, [activeRepoPath, orca, chatCards, dockChatCard]);

  const moveCard = useCallback((id: number, x: number, y: number) => {
    setCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  // ── Form-fit grid (#1239) — pack every card into a viewport-filling grid.
  // A ref mirror of all card geometry keeps applyGridLayout's identity stable so
  // the trigger effect below never loops on the layout's own per-frame writes.
  const gridItemsRef = useRef<Array<GridItem & { x: number; y: number; w: number; h: number }>>([]);
  useEffect(() => {
    gridItemsRef.current = [
      ...termCards.map((c) => ({ kind: 'term', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...fileCards.map((c) => ({ kind: 'file', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...imageCards.map((c) => ({ kind: 'image', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...browserCards.map((c) => ({ kind: 'browser', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...chatCards.map((c) => ({ kind: 'chat', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...diffCards.map((c) => ({ kind: 'diff', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...specCards.map((c) => ({ kind: 'spec', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...brainCards.map((c) => ({ kind: 'brain', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...markdownCards.map((c) => ({ kind: 'markdown', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
      ...agentCards.map((c) => ({ kind: 'agent', id: c.id, x: c.x, y: c.y, w: c.w, h: c.h })),
    ];
  }, [termCards, fileCards, imageCards, browserCards, chatCards, diffCards, specCards, brainCards, markdownCards, agentCards]);

  const gridAnimRef = useRef<{ stop: () => void } | null>(null);
  const [gridPlaceholder, setGridPlaceholder] = useState<Slot | null>(null);

  // Animate id→geom across all 8 card arrays with the ~180ms ease-out settle.
  const writeGridTargets = useCallback((targets: Map<number, { x: number; y: number; w: number; h: number }>) => {
    gridAnimRef.current?.stop();
    const starts = new Map(gridItemsRef.current.map((it) => [it.id, { x: it.x, y: it.y, w: it.w, h: it.h }]));
    const lerp = <T extends { id: number; x: number; y: number; w: number; h: number }>(card: T, t: number): T => {
      const s = starts.get(card.id);
      const e = targets.get(card.id);
      if (!s || !e) return card;
      // Only touch a dimension that actually changes — a pure reorder keeps the
      // cell size, so rewriting w/h every frame would needlessly churn the card
      // bodies (terminals re-fit on size change → render storms).
      const next = { ...card, x: s.x + (e.x - s.x) * t, y: s.y + (e.y - s.y) * t };
      if (Math.abs(e.w - s.w) > 1) next.w = Math.round(s.w + (e.w - s.w) * t);
      if (Math.abs(e.h - s.h) > 1) next.h = Math.round(s.h + (e.h - s.h) * t);
      return next;
    };
    const writeAll = (t: number) => {
      setTermCards((p) => p.map((c) => lerp(c, t)));
      setFileCards((p) => p.map((c) => lerp(c, t)));
      setImageCards((p) => p.map((c) => lerp(c, t)));
      setBrowserCards((p) => p.map((c) => lerp(c, t)));
      setChatCards((p) => p.map((c) => lerp(c, t)));
      setDiffCards((p) => p.map((c) => lerp(c, t)));
      setSpecCards((p) => p.map((c) => lerp(c, t)));
      setBrainCards((p) => p.map((c) => lerp(c, t)));
      setMarkdownCards((p) => p.map((c) => lerp(c, t)));
      setAgentCards((p) => p.map((c) => lerp(c, t)));
    };
    gridAnimRef.current = animate(0, 1, { duration: 0.18, ease: [0.22, 0.61, 0.36, 1], onUpdate: writeAll });
  }, []);

  // Core form-fit layout — pack `order` (card ids) into grid slots filling the
  // usable area minus a gap-margin (so the grid sits off the dock/rails/composer),
  // then animate everyone into place. Real chrome is measured per card so TOTAL
  // heights match the slot (no overlap, symmetric rows).
  const layoutGrid = useCallback((order: number[]) => {
    if (order.length === 0) return;
    const zoom = canvasZoom();
    const gap = 26 / zoom;
    const raw = usableCanvasArea();
    // Half-gap margin (the static insets already clear the rails/composer/dock) —
    // fills the field more generously so grid cells read bigger by default.
    const inset = { x: raw.x + gap / 2, y: raw.y + gap / 2, w: raw.w - gap, h: raw.h - gap };
    // Carve any FLOATING chrome the insets don't cover (the review picker) so
    // tiles never pack under it. Grid mode pins pan at origin, so panRef is (0,0).
    const area = carveChrome(inset, chromeRectsCanvas(panRef.current, zoom));
    if (area.w < 120 || area.h < 120) return;
    const byId = new Map(gridItemsRef.current.map((it) => [it.id, it]));
    // Pack with the REAL card kinds (index-keyed to `order`) so each tile takes
    // its kind's aspect — terminals land wider than agent tiles.
    const slotMap = computeGrid(order.map((id, i) => ({ id: i, kind: byId.get(id)?.kind ?? 'x' })), area, gap);
    const chromeOf = (id: number): number | undefined => {
      const it = byId.get(id);
      const el = typeof document !== 'undefined' ? document.querySelector(`[data-card-id="${id}"]`) : null;
      if (el instanceof HTMLElement && it) {
        // Chrome = rendered total − stored body `it.h`, measured with
        // `offsetHeight` (NOT getBoundingClientRect). Two reasons:
        //  1. A freshly-spawned card mounts under a motion spring
        //     (transform: scale .7→1); bcr reflects that transient scale, so
        //     measuring mid-mount handed back a shrunk height → bogus chrome →
        //     the card landed at the wrong size ("glitchy most times").
        //     offsetHeight is pure LAYOUT and ignores the transform.
        //  2. offsetHeight is already in LAYOUT px (CSS `zoom` isn't applied by
        //     this WebKit), the same space as the stored body `it.h`.
        // Accept chrome === 0 (>= 0): image/video cards bind height on the root
        // (root === body), so their chrome is genuinely 0. The old `c > 0` test
        // rejected that and fell through to the per-kind estimate (image: 28),
        // leaving photo/video cards a chrome-height SHORT of their cell — the
        // dead gap + outlined "wonky" tiles the operator saw. Now they fill the
        // full grid cell like every borderless shell card.
        //
        // Coordinate space: `it.h` and the slot are LAYER units. In-layer cards
        // sit under the canvas CSS-zoom layer, whose zoom this WebKit does NOT
        // fold into offsetHeight, so their offsetHeight is already layer units.
        // The o8.md spec card is the one card rendered OUT of that layer
        // (screenMap, so CodeMirror's caret hit-tests at device 1:1), so ITS
        // offsetHeight is real screen px = layerHeight × zoom. Difference the two
        // spaces and the chrome comes out garbage at any zoom ≠ 1 (negative →
        // wrong fallback, or wildly inflated → the card mis-sizes past its slot).
        // Divide the out-of-layer card back to layer units first.
        const layerHeight = it.kind === 'spec' ? el.offsetHeight / zoom : el.offsetHeight;
        const c = layerHeight - it.h;
        if (c >= 0 && c < 400) return c;
      }
      return undefined;
    };
    const targets = new Map<number, { x: number; y: number; w: number; h: number }>();
    order.forEach((id, i) => {
      const slot = slotMap.get(i);
      if (!slot) return;
      targets.set(id, slotToCardGeom(slot, byId.get(id)?.kind ?? 'x', chromeOf(id)));
    });
    writeGridTargets(targets);
  }, [writeGridTargets]);

  // Reading order (top→bottom, left→right) keeps the grid near each card's
  // current spot, so a reflow reads as "tidy", not "shuffle".
  const applyGridLayout = useCallback(() => {
    const order = [...gridItemsRef.current].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.id);
    layoutGrid(order);
  }, [layoutGrid]);

  // Restore the persisted mode + track window size for grid re-fits.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(GRID_MODE_KEY) === '1') setGridMode(true);
    } catch {
      // non-critical
    }
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Re-grid on: entering grid mode, card add/remove, resize, zoom, dock open/close
  // (the dock reserves right-side space, so the grid must re-pack clear of it).
  // Keyed on a COUNT signature (not the arrays) so the layout's own writes don't
  // re-trigger. dockOpen's --cnv-dock-reserve stamp effect is declared earlier, so
  // it lands before this reads usableCanvasArea().
  const gridCardCount =
    termCards.length + fileCards.length + imageCards.length + browserCards.length +
    chatCards.length + diffCards.length + specCards.length + brainCards.length + markdownCards.length +
    agentCards.length;

  // Navigator loupe minimap (#1239) — every card as a scaled rect; image cards
  // carry their thumbnail. The usable area is the minimap's stable frame.
  const minimapCards = useMemo<MinimapCard[]>(() => [
    ...termCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'term' })),
    ...fileCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'file' })),
    ...imageCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'image', src: c.items[0]?.src })),
    ...videoCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'video', src: c.poster })),
    ...browserCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'browser' })),
    ...chatCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'chat' })),
    ...diffCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'diff' })),
    ...specCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'spec' })),
    ...brainCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'brain' })),
    ...markdownCards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, kind: 'markdown' })),
  ], [termCards, fileCards, imageCards, videoCards, browserCards, chatCards, diffCards, specCards, brainCards, markdownCards]);
  // The navigator frames a region ~1.25× the viewport, CENTERED on where you're
  // looking (pan). Framing a bit MORE than the viewport keeps each card a small
  // tile (several tiling the sphere, reference-style) rather than 2-3 big cards
  // filling it. Uses canvasZoomLevel directly (not the lagged stamp).
  const loupeArea = useMemo(() => {
    const zoom = canvasZoomLevel || 1;
    const vw = winSize.w;
    const vh = winSize.h;
    const viewCenterX = (vw / 2 - pan.x) / zoom;
    const viewCenterY = (vh / 2 - pan.y) / zoom;
    const regionW = (vw / zoom) * 1.25;
    const regionH = (vh / zoom) * 1.25;
    return { x: viewCenterX - regionW / 2, y: viewCenterY - regionH / 2, w: regionW, h: regionH };
  }, [winSize.w, winSize.h, canvasZoomLevel, pan.x, pan.y]);

  useEffect(() => {
    if (!gridMode) return;
    // Defer past the commit + debounce rapid re-triggers: snapshot restore mounts
    // the cards across several renders, and applyGridLayout's per-frame animation
    // setState must never re-enter this effect synchronously (→ "maximum update
    // depth"). One rAF after the render storm settles applies the layout once.
    const raf = requestAnimationFrame(() => applyGridLayout());
    // The bottom DispatchDock tray appears + expands/collapses with a ~220ms
    // height animation; the rAF above would measure it mid-flight and under-
    // reserve. Re-pack once more after it settles so the grid ends above the tray
    // at its FINAL height. Cheap (layout is fast); harmless for the other triggers.
    const settle = window.setTimeout(() => applyGridLayout(), 260);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(settle); };
    // activeLanes.length = tray visibility, dockTrayExpanded = its expanded state
    // (both change the reserved bottom stack height, same role as dockOpen).
  }, [gridMode, gridCardCount, winSize.w, winSize.h, canvasZoomLevel, dockOpen, activeLanes.length, dockTrayExpanded, applyGridLayout]);

  // Grid mode packs to the viewport — snap the pan back to origin so the grid
  // lands centered, not wherever you'd roamed.
  useEffect(() => {
    if (gridMode) setPan({ x: 0, y: 0 });
  }, [gridMode]);

  // Two-finger scroll pans the infinite canvas (free mode only), over the canvas
  // background — cards keep their own content scroll, chrome is untouched. Window
  // listener (not onWheel) so it fires reliably + can preventDefault. `pan` is a
  // SCREEN-px offset (WebKit `transform: translate` on a `zoom` layer is NOT
  // scaled by the zoom), so the scroll delta maps 1:1.
  useEffect(() => {
    if (gridMode) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.('[data-canvas-layer]')) return;
      if (target.closest('[data-card-id]')) return;
      event.preventDefault();
      setPan((prev) => ({ x: prev.x - event.deltaX, y: prev.y - event.deltaY }));
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [gridMode]);

  useEffect(() => {
    // Stamp the mode so canvas-drag's dragBounds knows whether to fence (grid) or
    // roam (free / infinite canvas).
    document.documentElement.style.setProperty('--cnv-grid', gridMode ? '1' : '0');
    try {
      window.localStorage.setItem(GRID_MODE_KEY, gridMode ? '1' : '0');
    } catch {
      // non-critical
    }
  }, [gridMode]);

  // Grid drag-to-reorder with LIVE placeholder (the reference feel): pick a card
  // up (it floats free via its own drag), the others reflow INSTANTLY to open a
  // hole where it will land, a ghost slot marks the spot, and on drop everyone
  // settles with the ease. No per-card wiring — the lifted card is identified by
  // its data-card-id under the pointer; its live center picks the target slot.
  useEffect(() => {
    if (!gridMode) return;
    let drag: { id: number; order: number[]; lastIndex: number; placed: boolean } | null = null;
    // Coalesce the reflow to one per animation frame: pointermove fires far faster
    // than we want to re-pack, and deferring the setState to rAF keeps it off the
    // render/commit path (no "maximum update depth" under a fast drag).
    let reflowRaf = 0;

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) { drag = null; return; }
      const el = (event.target as HTMLElement | null)?.closest?.('[data-card-id]');
      if (!el) { drag = null; return; }
      const id = Number(el.getAttribute('data-card-id'));
      const order = [...gridItemsRef.current].sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.id);
      const idx = order.indexOf(id);
      if (idx < 0) { drag = null; return; }
      drag = { id, order, lastIndex: idx, placed: false };
    };

    const onMove = () => {
      if (!drag || reflowRaf) return;
      reflowRaf = requestAnimationFrame(() => {
        reflowRaf = 0;
        if (!drag) return;
        const liftedEl = document.querySelector(`[data-card-id="${drag.id}"]`);
        if (!liftedEl) return;
        const zoom = canvasZoom();
        const r = liftedEl.getBoundingClientRect();
        const cx = (r.left + r.width / 2) / zoom;
        const cy = (r.top + r.height / 2) / zoom;
        const gap = 26 / zoom;
        const raw = usableCanvasArea();
        // Same packing area as layoutGrid — half-gap inset, then carve floating
        // chrome — so the drag placeholder lands exactly where the drop will.
        const inset = { x: raw.x + gap / 2, y: raw.y + gap / 2, w: raw.w - gap, h: raw.h - gap };
        const area = carveChrome(inset, chromeRectsCanvas(panRef.current, zoom));
        const kindOf = new Map(gridItemsRef.current.map((it) => [it.id, it.kind]));
        const slotMap = computeGrid(drag.order.map((id, i) => ({ id: i, kind: kindOf.get(id) ?? 'x' })), area, gap);
        let targetIndex = drag.lastIndex;
        let best = Infinity;
        for (let i = 0; i < drag.order.length; i += 1) {
          const s = slotMap.get(i);
          if (!s) continue;
          const dx = s.x + s.w / 2 - cx;
          const dy = s.y + s.h / 2 - cy;
          const d = dx * dx + dy * dy;
          if (d < best) { best = d; targetIndex = i; }
        }
        if (drag.placed && targetIndex === drag.lastIndex) return; // ghost already here
        drag.lastIndex = targetIndex;
        drag.placed = true;
        // Show the ghost where the card will land — but DON'T reflow the other cards
        // mid-drag. Re-rendering the heavy card bodies (terminals/chats) every reflow
        // frame trips their own effects' update-depth guard under StrictMode. Only
        // the lightweight placeholder updates here (the others keep unchanged props,
        // so React skips re-rendering them); everything re-packs on drop.
        const slotArr: Slot[] = [];
        for (let i = 0; i < drag.order.length; i += 1) {
          const s = slotMap.get(i);
          if (s) slotArr.push(s);
        }
        setGridPlaceholder(slotArr[targetIndex] ?? null);
      });
    };

    const onUp = () => {
      if (reflowRaf) { cancelAnimationFrame(reflowRaf); reflowRaf = 0; }
      if (drag && drag.placed) {
        const others = drag.order.filter((other) => other !== drag!.id);
        const finalOrder = [...others];
        finalOrder.splice(drag.lastIndex, 0, drag.id); // lifted lands at the placeholder
        layoutGrid(finalOrder);
      }
      setGridPlaceholder(null);
      drag = null;
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp);
      if (reflowRaf) cancelAnimationFrame(reflowRaf);
      setGridPlaceholder(null);
    };
  }, [gridMode, layoutGrid]);

  /** Spawn a REAL shell — production transport, canvas treatment. */
  const spawnTerminal = useCallback((cwd: string | null, cwdLabel: string | null, at?: SnapGeometry, opts?: { agentCli?: string }) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    const requestId = `cnv-term-${id}-${Math.random().toString(36).slice(2, 8)}`;
    const revealHold = firstSpawnRef.current;
    firstSpawnRef.current = false;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const z = zPeakRef.current;
    const spot = at ?? findFreeSpot(560, 336);
    setTermCards((previous) => [...previous, {
      id,
      requestId,
      sessionName: null,
      exited: false,
      live: false,
      revealHold,
      x: spot.x,
      y: spot.y,
      w: at?.w ?? 560,
      h: at?.h ?? 300,
      z,
      cwd,
      cwdLabel,
      agentCli: opts?.agentCli,
    }]);
    sendTerminalCreate(120, 30, requestId, cwd ?? undefined);
  }, [findFreeSpot, sendTerminalCreate]);

  // #6 persistent terminals — re-attach a canvas shell whose tmux session
  // survived a restart/crash instead of respawning fresh. The card is created
  // with `sessionName` already set, so XtermPanel mounts keyed on it and its
  // mount effect sends terminal-attach (the ws-server re-attach path replays
  // scrollback). cdSentRef is pre-seeded so the cd+clear on first attach does
  // NOT run — the surviving shell keeps its own cwd and history.
  const reattachTerminal = useCallback((sessionName: string, cwd: string | null, cwdLabel: string | null, at?: SnapGeometry) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    firstSpawnRef.current = false;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const z = zPeakRef.current;
    const spot = at ?? findFreeSpot(560, 336);
    liveSessionsRef.current.add(sessionName);
    cdSentRef.current.add(sessionName);
    setTermCards((previous) => [...previous, {
      id,
      requestId: `cnv-term-${id}-reattach`,
      sessionName,
      exited: false,
      live: false,
      revealHold: false,
      x: spot.x,
      y: spot.y,
      w: at?.w ?? 560,
      h: at?.h ?? 300,
      z,
      cwd,
      cwdLabel,
    }]);
  }, [findFreeSpot]);

  const moveTermCard = useCallback((id: number, x: number, y: number) => {
    setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeTermCard = useCallback((id: number, w: number, h: number) => {
    setTermCards((previous) => previous.map((card) => (card.id === id ? { ...card, w, h } : card)));
  }, []);

  /** Clicked card comes forward. Terminals + files + images + browsers +
   *  chats share the 10–39 band — above mock cards (3), below chrome (40+). */
  const focusCard = useCallback((kind: 'term' | 'file' | 'image' | 'video' | 'browser' | 'chat' | 'diff' | 'spec' | 'brain' | 'markdown' | 'agent', id: number) => {
    const current = kind === 'term'
      ? termCards.find((card) => card.id === id)
      : kind === 'file'
        ? fileCards.find((card) => card.id === id)
        : kind === 'image'
          ? imageCards.find((card) => card.id === id)
          : kind === 'video'
            ? videoCards.find((card) => card.id === id)
            : kind === 'browser'
              ? browserCards.find((card) => card.id === id)
              : kind === 'chat'
                ? chatCards.find((card) => card.id === id)
                : kind === 'diff'
                  ? diffCards.find((card) => card.id === id)
                  : kind === 'spec'
                    ? specCards.find((card) => card.id === id)
                    : kind === 'brain'
                      ? brainCards.find((card) => card.id === id)
                      : kind === 'markdown'
                        ? markdownCards.find((card) => card.id === id)
                        : agentCards.find((card) => card.id === id);
    if (!current || current.z === zPeakRef.current) return;
    if (zPeakRef.current + 1 > 38) {
      // Renormalize the whole band, keeping order, with the target on top.
      const combined = [
        ...termCards.map((card) => ({ kind: 'term' as const, id: card.id, z: card.z })),
        ...fileCards.map((card) => ({ kind: 'file' as const, id: card.id, z: card.z })),
        ...imageCards.map((card) => ({ kind: 'image' as const, id: card.id, z: card.z })),
        ...videoCards.map((card) => ({ kind: 'video' as const, id: card.id, z: card.z })),
        ...browserCards.map((card) => ({ kind: 'browser' as const, id: card.id, z: card.z })),
        ...chatCards.map((card) => ({ kind: 'chat' as const, id: card.id, z: card.z })),
        ...diffCards.map((card) => ({ kind: 'diff' as const, id: card.id, z: card.z })),
        ...specCards.map((card) => ({ kind: 'spec' as const, id: card.id, z: card.z })),
        ...brainCards.map((card) => ({ kind: 'brain' as const, id: card.id, z: card.z })),
        ...markdownCards.map((card) => ({ kind: 'markdown' as const, id: card.id, z: card.z })),
        ...agentCards.map((card) => ({ kind: 'agent' as const, id: card.id, z: card.z })),
      ].sort((a, b) => a.z - b.z);
      const remap = new Map(combined.map((entry, index) => [`${entry.kind}:${entry.id}`, 10 + index]));
      const top = 10 + combined.length;
      setTermCards((previous) => previous.map((card) => ({ ...card, z: kind === 'term' && card.id === id ? top : remap.get(`term:${card.id}`) ?? card.z })));
      setFileCards((previous) => previous.map((card) => ({ ...card, z: kind === 'file' && card.id === id ? top : remap.get(`file:${card.id}`) ?? card.z })));
      setImageCards((previous) => previous.map((card) => ({ ...card, z: kind === 'image' && card.id === id ? top : remap.get(`image:${card.id}`) ?? card.z })));
      setVideoCards((previous) => previous.map((card) => ({ ...card, z: kind === 'video' && card.id === id ? top : remap.get(`video:${card.id}`) ?? card.z })));
      setBrowserCards((previous) => previous.map((card) => ({ ...card, z: kind === 'browser' && card.id === id ? top : remap.get(`browser:${card.id}`) ?? card.z })));
      setChatCards((previous) => previous.map((card) => ({ ...card, z: kind === 'chat' && card.id === id ? top : remap.get(`chat:${card.id}`) ?? card.z })));
      setDiffCards((previous) => previous.map((card) => ({ ...card, z: kind === 'diff' && card.id === id ? top : remap.get(`diff:${card.id}`) ?? card.z })));
      setSpecCards((previous) => previous.map((card) => ({ ...card, z: kind === 'spec' && card.id === id ? top : remap.get(`spec:${card.id}`) ?? card.z })));
      setBrainCards((previous) => previous.map((card) => ({ ...card, z: kind === 'brain' && card.id === id ? top : remap.get(`brain:${card.id}`) ?? card.z })));
      setMarkdownCards((previous) => previous.map((card) => ({ ...card, z: kind === 'markdown' && card.id === id ? top : remap.get(`markdown:${card.id}`) ?? card.z })));
      setAgentCards((previous) => previous.map((card) => ({ ...card, z: kind === 'agent' && card.id === id ? top : remap.get(`agent:${card.id}`) ?? card.z })));
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
    } else if (kind === 'video') {
      setVideoCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'browser') {
      setBrowserCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'chat') {
      setChatCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'diff') {
      setDiffCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'spec') {
      setSpecCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'brain') {
      setBrainCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else if (kind === 'markdown') {
      setMarkdownCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    } else {
      setAgentCards((previous) => previous.map((card) => (card.id === id ? { ...card, z } : card)));
    }
  }, [agentCards, brainCards, markdownCards, browserCards, chatCards, diffCards, fileCards, imageCards, videoCards, specCards, termCards]);

  const focusTermCard = useCallback((id: number) => focusCard('term', id), [focusCard]);
  const focusFileCard = useCallback((id: number) => focusCard('file', id), [focusCard]);
  const focusImageCard = useCallback((id: number) => focusCard('image', id), [focusCard]);
  const focusVideoCard = useCallback((id: number) => focusCard('video', id), [focusCard]);
  const focusBrowserCard = useCallback((id: number) => focusCard('browser', id), [focusCard]);
  const focusChatCard = useCallback((id: number) => focusCard('chat', id), [focusCard]);
  const focusDiffCard = useCallback((id: number) => focusCard('diff', id), [focusCard]);
  const focusSpecCard = useCallback((id: number) => focusCard('spec', id), [focusCard]);
  const focusBrainCard = useCallback((id: number) => focusCard('brain', id), [focusCard]);
  const focusMarkdownCard = useCallback((id: number) => focusCard('markdown', id), [focusCard]);
  const focusAgentCard = useCallback((id: number) => focusCard('agent', id), [focusCard]);
  /** Toggle an agent card compact ↔ full — snaps to that mode's preset size so
   *  the transcript+composer get room in full and the status tile stays tight in
   *  compact. The o8_canvas resize verb still resizes either mode afterward. */
  const toggleAgentCardExpand = useCallback((id: number) => {
    setAgentCards((previous) => previous.map((card) => (
      card.id === id
        ? card.expanded
          ? { ...card, expanded: false, w: AGENT_COMPACT_W, h: AGENT_COMPACT_H }
          : { ...card, expanded: true, w: AGENT_FULL_W, h: AGENT_FULL_H }
        : card
    )));
  }, []);

  const reducedMotion = useCallback(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ), []);

  const viewportSpawnOrigin = useCallback(() => {
    const z = canvasZoom();
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1600;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    return {
      x: (vw / 2 - pan.x) / z - 140,
      y: (vh / 2 - pan.y) / z - 64,
    };
  }, [pan.x, pan.y]);

  const takeSpawnChoreography = useCallback((): SpawnChoreography | null => {
    const now = Date.now();
    spawnChoreographyRef.current = spawnChoreographyRef.current.filter((entry) => entry.expiresAt > now);
    const [entry] = spawnChoreographyRef.current.splice(0, 1);
    return entry ?? null;
  }, []);

  /** Bloom an agent card for a freshly-live lane — the spawn → card-appears
   *  moment. Deduped by laneId so a lane is only ever carded once; the card then
   *  tracks that lane's phase live from activeLanes. */
  const bloomAgentCard = useCallback((lane: LaneRow) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    // Cluster near siblings — the last card in this repo, else the last agent
    // card overall (same spawn burst). findFreeSpot returns the nearest FREE
    // cell to the anchor, so a fleet reads as a group.
    const anchor = (lane.repoPath ? agentAnchorsRef.current.byRepo.get(lane.repoPath) : null) ?? agentAnchorsRef.current.last;
    const target = findFreeSpot(AGENT_FULL_W, AGENT_FULL_H, anchor);
    agentAnchorsRef.current.last = target;
    if (lane.repoPath) agentAnchorsRef.current.byRepo.set(lane.repoPath, target);
    const choreography = reducedMotion() ? null : takeSpawnChoreography();
    const start = choreography?.origin ?? target;
    // Always reserve the target — cardRectsRef only picks up the real rect on the
    // next commit's effect, so a synchronous burst (entering the canvas over a
    // running fleet) would otherwise read a stale field and stack every card on
    // the same spot. Released once the card's rect takes over collision duty.
    const reservation = { id, x: target.x, y: target.y, w: AGENT_FULL_W, h: AGENT_FULL_H };
    spawnReservationsRef.current.push(reservation);
    setAgentCards((previous) => {
      if (previous.some((card) => card.laneId === lane.id)) {
        spawnReservationsRef.current = spawnReservationsRef.current.filter((entry) => entry !== reservation);
        return previous;
      }
      zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
      const number = agentNumberRef.current;
      agentNumberRef.current += 1;
      const repoTail = lane.repoPath?.split('/').filter(Boolean).pop() ?? null;
      const symonOrigin = Boolean(
        (lane.packetId && symonSpawnPacketIdsRef.current.has(lane.packetId))
        || symonSpawnPacketIdsRef.current.has(lane.id)
        || Date.now() < symonSpawnWindowUntilRef.current,
      );
      return [...previous, {
        id,
        x: start.x,
        y: start.y,
        z: zPeakRef.current,
        w: AGENT_FULL_W,
        h: AGENT_FULL_H,
        laneId: lane.id,
        packetId: lane.packetId ?? null,
        sessionKey: lane.sessionKey ?? null,
        repoPath: lane.repoPath ?? null,
        startedAt: lane.createdAt ?? null,
        expanded: true,
        number,
        codename: codename(lane.id),
        title: lane.label?.trim() || repoTail || lane.id,
        runtime: lane.runtime ?? null,
        ...(symonOrigin ? { symonOrigin: true } : {}),
      }];
    });
    if (choreography) {
      timersRef.current.push(setTimeout(() => {
        animate(0, 1, {
          duration: CARD_ENTRANCE.sweepMs / 1000,
          ease: [0.22, 0.61, 0.36, 1],
          onUpdate: (t) => {
            setAgentCards((cards) => cards.map((card) => (
              card.id === id ? { ...card, x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t } : card
            )));
          },
          onComplete: () => {
            spawnReservationsRef.current = spawnReservationsRef.current.filter((entry) => entry !== reservation);
          },
        });
      }, choreography.delayMs));
    } else {
      // Static bloom (entry burst / single new lane): hold the reservation just
      // long enough for the next commit's cardRects effect to pick up the real
      // card rect, then release so it doesn't over-reserve the field.
      timersRef.current.push(setTimeout(() => {
        spawnReservationsRef.current = spawnReservationsRef.current.filter((entry) => entry !== reservation);
      }, 400));
    }
  }, [findFreeSpot, reducedMotion, takeSpawnChoreography]);

  /** Watch live lanes: bloom a card for every lane not yet carded — including the
   *  fleet already running when the canvas opens (dispatched from the IDE/MCP
   *  while it was closed). Entering the canvas cards them ALL (entrance animation,
   *  no choreography), deduped by laneId. Cards read their phase live from
   *  activeLanes thereafter; a lane leaving the set settles its card to "done". */
  useEffect(() => {
    if (!canvasEnabled) return;
    for (const lane of activeLanes) {
      if (cardedLaneIdsRef.current.has(lane.id)) continue;
      cardedLaneIdsRef.current.add(lane.id);
      bloomAgentCard(lane);
    }
  }, [activeLanes, bloomAgentCard, canvasEnabled]);

  /** Voice/canvas "spawn N agents on <task>" — the gateless worktree spawn. Hits
   *  the governed create+dispatch seam (/api/orchestrator/spawn-prompt); the new
   *  lanes go live and bloom as cards via the watcher above. Returns an ack note
   *  on a synchronous validation failure, else null (ok). */
  const spawnAgents = useCallback((task: string, count: number, repoOverride?: string | null, origin?: string | null): string | null => {
    const repoPath = repoOverride ?? activeRepoPath;
    if (!task.trim()) return 'spawn-agents needs args.task';
    if (!repoPath) return 'no repo scoped — pick a repo first';
    const n = Math.max(1, Math.min(5, Math.floor(count) || 1));
    if (origin === 'symon') symonSpawnWindowUntilRef.current = Date.now() + 20_000;
    if (n > 1 && !reducedMotion()) {
      const spawnOrigin = viewportSpawnOrigin();
      const expiresAt = Date.now() + SPAWN_CHOREOGRAPHY_TTL_MS;
      spawnChoreographyRef.current.push(...Array.from({ length: n }, (_, index) => ({
        repoPath,
        origin: spawnOrigin,
        delayMs: index * CARD_ENTRANCE.staggerMs,
        expiresAt,
      })));
    }
    fetch('/api/orchestrator/spawn-prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, task: task.trim(), count: n, ...(origin === 'symon' ? { origin } : {}) }),
    })
      .then((response) => response.json().catch(() => null))
      .then((data: { result?: { packetIds?: unknown; packets?: Array<{ id?: unknown }> }; packetIds?: unknown; packets?: Array<{ id?: unknown }> } | null) => {
        if (origin === 'symon') {
          const result = data?.result ?? data ?? null;
          const ids = Array.isArray(result?.packetIds)
            ? result.packetIds
            : Array.isArray(result?.packets)
              ? result.packets.map((packet) => packet.id)
              : [];
          for (const id of ids) {
            if (typeof id === 'string' && id) symonSpawnPacketIdsRef.current.add(id);
          }
        }
        // The lane-lifecycle push usually beats these, but a couple of nudges
        // catch the lanes as the worktrees + sessions come up (~1–3s).
        refreshLanes();
        timersRef.current.push(setTimeout(refreshLanes, 1200));
        timersRef.current.push(setTimeout(refreshLanes, 3000));
      })
      .catch(() => {
        if (origin === 'symon') symonSpawnWindowUntilRef.current = 0;
      });
    return null;
  }, [activeRepoPath, reducedMotion, refreshLanes, viewportSpawnOrigin]);

  useEffect(() => {
    if (!canvasEnabled || !inTauri) return;
    const liveIds = new Set(activeLanes.map((lane) => lane.id));
    for (const card of agentCards) {
      // Announce the ASSIGNED card name the moment a Symon-spawned card lands —
      // the spawn is async, so the model can't know the codename at dispatch
      // time and must never invent one (2026-07-08: voice "Pigeon", card "Pike").
      if (card.symonOrigin && liveIds.has(card.laneId) && !announcedSymonLaneIdsRef.current.has(card.laneId)) {
        announcedSymonLaneIdsRef.current.add(card.laneId);
        const spawnLabel = card.codename || card.title || `Agent ${card.number}`;
        void symonSpeakStatus(`${spawnLabel} is on it`);
      }
      if (!card.symonOrigin || liveIds.has(card.laneId) || spokenSymonLaneIdsRef.current.has(card.laneId)) continue;
      spokenSymonLaneIdsRef.current.add(card.laneId);
      const label = card.codename || card.title || `Agent ${card.number}`;
      void symonSpeakStatus(`${label} is done`);
    }
  }, [activeLanes, agentCards, canvasEnabled, inTauri]);

  /** A lane's review diff lands as a glass card — the governance moat
   *  as a canvas object. */
  const spawnDiffCard = useCallback((lane: LaneRow, at?: SnapGeometry) => {
    return fetch(`/api/lanes/${encodeURIComponent(lane.id)}/diff?maxBytes=131072`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; packetId?: string | null; branch?: string | null; stat?: string; diff?: string; truncated?: boolean } | null) => {
        if (!data?.ok) return;
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const spot = at ?? findFreeSpot(560, 356);
        setDiffCards((previous) => [...previous, {
          id,
          x: spot.x,
          y: spot.y,
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
  }, [findFreeSpot]);

  /** "What have I changed" — the active repo's WORKING-TREE diff in the
   *  same card the lane diffs use. laneId carries a worktree: prefix so
   *  the restore path knows which fetch to replay. */
  const spawnWorktreeDiffCard = useCallback((at?: SnapGeometry, repoOverride?: string) => {
    const repoPath = repoOverride ?? activeRepoPath;
    if (!repoPath) return Promise.resolve();
    const repoTail = repoPath.split('/').filter(Boolean).pop() ?? repoPath;
    return fetch(`/api/panel/worktree-diff?workspace=${encodeURIComponent(repoPath)}&maxBytes=131072`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; branch?: string | null; stat?: string; diff?: string; truncated?: boolean } | null) => {
        if (!data?.ok) return;
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const spot = at ?? findFreeSpot(560, 356);
        setDiffCards((previous) => {
          // One working-tree card per repo — auto-show + the picker row both
          // route here, so a re-trigger must never stack a duplicate.
          if (previous.some((card) => card.laneId === `worktree:${repoPath}`)) return previous;
          return [...previous, {
            id,
            x: spot.x,
            y: spot.y,
            z: zPeakRef.current,
            w: at?.w ?? 560,
            h: at?.h ?? 320,
            laneId: `worktree:${repoPath}`,
            packetId: null,
            title: `Your changes — ${repoTail}`,
            branch: data.branch ?? null,
            stat: data.stat ?? '',
            diff: data.diff?.trim() ? data.diff : 'Working tree clean — nothing uncommitted.',
            truncated: Boolean(data.truncated),
          }];
        });
      })
      .catch(() => {});
  }, [activeRepoPath, findFreeSpot]);

  /** The active review's PR diff as a glass card — what the Alerts
   *  "Review ready · PR #N" row resolves to. Distinct from the working-tree
   *  card: this is the review branch vs its base (the PR itself), NOT your
   *  uncommitted edits in whatever repo the canvas happens to point at —
   *  that mismatch was the bug this replaced. laneId carries a review:
   *  prefix so the restore path and dedupe both recognise it. */
  const spawnReviewDiffCard = useCallback((at?: SnapGeometry) => {
    // No workspace param — match the inbox alert, which is built from the
    // GLOBAL review snapshot (not the canvas's active repo). Passing the active
    // repo here would re-introduce the very mismatch this card fixes.
    return fetch('/api/review/diff')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { ok?: boolean; branch?: string | null; stat?: string; diff?: string; truncated?: boolean; prNumber?: number | null; prTitle?: string | null } | null) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const spot = at ?? findFreeSpot(560, 356);
        const pr = data?.ok ? data.prNumber ?? null : null;
        const title = pr
          ? `PR #${pr}${data?.prTitle ? ` · ${data.prTitle}` : ''}`
          : data?.ok
            ? `Review · ${data.branch ?? 'changes'}`
            : 'Review';
        const body = data?.ok
          ? (data.diff?.trim() ? data.diff : 'No diff is available for this review yet.')
          : 'No active review workspace is configured.';
        setDiffCards((previous) => {
          // One review card at a time — the PR alert always resolves here.
          if (previous.some((card) => card.laneId.startsWith('review:'))) return previous;
          return [...previous, {
            id,
            x: spot.x,
            y: spot.y,
            z: zPeakRef.current,
            w: at?.w ?? 560,
            h: at?.h ?? 320,
            laneId: `review:${pr ?? data?.branch ?? 'active'}`,
            packetId: null,
            title,
            branch: data?.ok ? data.branch ?? null : null,
            stat: data?.ok ? data.stat ?? '' : '',
            diff: body,
            truncated: Boolean(data?.ok && data.truncated),
          }];
        });
      })
      .catch(() => {});
  }, [findFreeSpot]);

  // Auto-show YOUR working tree the moment the Review picker opens — no
  // hunting for the row. spawnWorktreeDiffCard dedupes, so this never stacks.
  useEffect(() => {
    if (reviewPickerOpen && activeRepoPath) void spawnWorktreeDiffCard();
  }, [reviewPickerOpen, activeRepoPath, spawnWorktreeDiffCard]);

  /** Mark an alert seen — dims the row + drops it from the bell count, and
   *  persists so a reload doesn't re-surface what you've already acted on. */
  const acknowledgeAlert = useCallback((id: string) => {
    setSeenAlerts((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      try { window.localStorage.setItem('o8:canvas-alerts-seen', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  /** Alerts dropdown → jump to the surface that resolves the row, and mark it
   *  seen. A review opens (or focuses) the PR diff card — the review branch vs
   *  its base, NOT the active repo's working tree (that mismatch was the bug).
   *  Everything else — the mirrored chat, a pending approval, an agent alert —
   *  opens the orchestrator dock, where those threads and approvals live. */
  const jumpToAlert = useCallback((item: InboxRow) => {
    setTopMenu(null);
    acknowledgeAlert(item.id);
    if (item.kind === 'review') {
      const open = diffCards.find((card) => card.laneId.startsWith('review:'));
      if (open) focusDiffCard(open.id);
      else void spawnReviewDiffCard();
      return;
    }
    setDockOpen(true);
  }, [acknowledgeAlert, diffCards, focusDiffCard, spawnReviewDiffCard]);

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
    const spot = findFreeSpot(760, 540);
    setSpecCards((previous) => [...previous, {
      id,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 760,
      h: 540,
      repoPath,
    }]);
  }, [activeRepoPath, findFreeSpot, focusSpecCard, specCards]);

  /** The Engineering Brain as a card — one per repo, like the o8.md card;
   *  a second click focuses the open one. An intent-bus question rides in as
   *  a one-shot `initialQuestion` the card asks itself. */
  const spawnBrainCard = useCallback((question?: string) => {
    const repoPath = activeRepoPath ?? null;
    const open = brainCards.find((card) => card.repoPath === repoPath);
    if (open) {
      focusBrainCard(open.id);
      if (question?.trim()) {
        setBrainCards((previous) => previous.map((card) => (
          card.id === open.id ? { ...card, initialQuestion: question.trim() } : card
        )));
      }
      return;
    }
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(360, 460);
    setBrainCards((previous) => [...previous, {
      id,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 360,
      h: 380,
      repoPath,
      ...(question?.trim() ? { initialQuestion: question.trim() } : {}),
    }]);
  }, [activeRepoPath, brainCards, findFreeSpot, focusBrainCard]);

  /** Render-on-screen (#1270) — bloom a markdown explainer the orchestrator
   *  authored. Each call is a fresh card (you can show several), sized for a
   *  comfortable read; the content is static + ephemeral. */
  const spawnMarkdownCard = useCallback((title: string, markdown: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(380, 460);
    setMarkdownCards((previous) => [...previous, {
      id,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 380,
      h: 360,
      title: title.trim() || 'Note',
      markdown,
    }]);
  }, [findFreeSpot]);

  /** A REAL browser pane — defaults to the app's own dashboard. */
  const spawnBrowserCard = useCallback(() => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const spot = findFreeSpot(640, 492);
    setBrowserCards((previous) => [...previous, {
      id,
      x: spot.x,
      y: spot.y,
      z: zPeakRef.current,
      w: 640,
      h: 400,
      tabs: [{ id: 1, url: `${window.location.origin}/dashboard` }],
      activeTabId: 1,
    }]);
  }, [findFreeSpot]);

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
          const spot = findFreeSpot(640, 492);
          return [{ id, x: spot.x, y: spot.y, z: zPeakRef.current, w: 640, h: 400, tabs: [{ id: 1, url }], activeTabId: 1 }];
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
  }, [findFreeSpot]);

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
    const spot = at ?? findFreeSpot(620, 456);
    setFileCards((previous) => [...previous, {
      id,
      path,
      name: path.split('/').pop() || path,
      x: spot.x,
      y: spot.y,
      w: at?.w ?? 620,
      h: at?.h ?? 420,
      z,
    }]);
  }, [findFreeSpot]);

  const showCanvasToast = useCallback((message: string, tone: CanvasToast['tone'] = 'error') => {
    const id = Date.now();
    setCanvasToast({ id, message, tone });
    if (canvasToastTimerRef.current) clearTimeout(canvasToastTimerRef.current);
    canvasToastTimerRef.current = setTimeout(() => {
      setCanvasToast((current) => (current?.id === id ? null : current));
      canvasToastTimerRef.current = null;
    }, 3600);
  }, []);

  const openPathAsFileCard = useCallback((rawPath: string): boolean => {
    const path = rawPath.trim();
    if (!path) {
      showCanvasToast('Enter an absolute file path.', 'error');
      return false;
    }
    if (!path.startsWith('/')) {
      showCanvasToast('Open file needs an absolute path.', 'error');
      return false;
    }
    spawnFileCard(path);
    setFilePathPickerOpen(false);
    setFilePathInput('');
    showCanvasToast('File card opened.', 'success');
    return true;
  }, [showCanvasToast, spawnFileCard]);

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
    const snap = loadCanvasSnapshot();
    if (!snap) return;
    // Ceiling, not the arm point — the async restores release it early
    // below. A dev-server cold compile can hold a thread fetch past any
    // fixed short window, and a save in that gap loses the unfetched cards.
    persistArmedAtRef.current = Date.now() + 12000;
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
    if (snap.brain?.length) {
      setBrainCards((previous) => [...previous, ...(snap.brain ?? []).map((saved) => {
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
    if (snap.markdown?.length) {
      setMarkdownCards((previous) => [...previous, ...(snap.markdown ?? []).map((saved) => {
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, title: saved.title, markdown: saved.markdown };
      })]);
    }
    snap.file.forEach((saved) => spawnFileCard(saved.path, saved));
    // Video cards restore async — the bytes come back from IndexedDB and get a
    // fresh object URL (the snapshot only carried the media id). A clip whose
    // blob is gone (storage cleared) drops silently.
    const videoRestores = (snap.video ?? []).map(async (saved) => {
      const blob = await getMedia(saved.mediaId);
      if (!blob) return;
      const src = URL.createObjectURL(blob);
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
      setVideoCards((previous) => [...previous, { id, x: saved.x, y: saved.y, z: zPeakRef.current, w: saved.w, h: saved.h, aspect: saved.aspect, src, name: saved.name, mediaId: saved.mediaId }]);
    });
    const settles: Array<Promise<unknown>> = [
      ...videoRestores,
      ...snap.chat.map((saved) => pickThread(saved.threadId, saved.repoPath, { title: saved.title, repoName: saved.repoName }, saved)),
      ...snap.diff.map((saved) => (saved.laneId.startsWith('worktree:')
        ? spawnWorktreeDiffCard(saved, saved.laneId.slice('worktree:'.length)) ?? Promise.resolve()
        : spawnDiffCard({ id: saved.laneId, label: saved.title }, saved))),
    ];
    if (snap.term.length) {
      // The terminal ws needs a beat to connect before create requests land.
      // #6 persistent terminals — re-attach saved shells whose tmux session
      // survived (checkAliveSessions unions live tmux sessions under the flag);
      // respawn the rest fresh, exactly as before.
      setTimeout(() => {
        void (async () => {
          const names = snap.term.map((saved) => saved.sessionName).filter((name): name is string => Boolean(name));
          const alive = names.length ? await checkAliveSessions(names) : new Set<string>();
          snap.term.forEach((saved) => {
            if (saved.sessionName && alive.has(saved.sessionName)) {
              reattachTerminal(saved.sessionName, saved.cwd, saved.cwdLabel, saved);
            } else {
              spawnTerminal(saved.cwd, saved.cwdLabel, saved);
            }
          });
        })();
      }, 1200);
    }
    void Promise.allSettled(settles).then(() => {
      // Every fetch-backed card has landed (or dropped) — release the save
      // guard, padded past the terminal respawn timer.
      persistArmedAtRef.current = Math.min(persistArmedAtRef.current, Date.now() + 2000);
    });
  }, [pickThread, spawnDiffCard, spawnFileCard, spawnTerminal, reattachTerminal, spawnWorktreeDiffCard]);

  // Save: one debounced snapshot whenever anything persistent changes.
  // The signature string IS the snapshot body — transient fields (term
  // liveness, diff text, chat entries) are excluded so churn never
  // thrashes localStorage.
  const persistSignature = useMemo(() => JSON.stringify({
    activeRepoPath,
    dockOpen,
    term: termCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, cwd: card.cwd, cwdLabel: card.cwdLabel, sessionName: card.sessionName })),
    file: fileCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, path: card.path })),
    image: imageCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, aspect: card.aspect, items: card.items })),
    video: videoCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, aspect: card.aspect, mediaId: card.mediaId, name: card.name })),
    browser: browserCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, tabs: card.tabs, activeTabId: card.activeTabId })),
    chat: chatCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, threadId: card.threadId, repoPath: card.repoPath, repoName: card.repoName, title: card.title })),
    diff: diffCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, laneId: card.laneId, title: card.title })),
    spec: specCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, repoPath: card.repoPath })),
    markdown: markdownCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, title: card.title, markdown: card.markdown })),
    brain: brainCards.map((card) => ({ x: Math.round(card.x), y: Math.round(card.y), w: card.w, h: card.h, repoPath: card.repoPath })),
  }), [activeRepoPath, dockOpen, termCards, fileCards, imageCards, videoCards, browserCards, chatCards, diffCards, specCards, markdownCards, brainCards]);
  const flushCanvasSnapshot = useCallback((force = false) => {
    if (!restoredRef.current || (!force && Date.now() < persistArmedAtRef.current)) return;
    saveCanvasSnapshot({ v: 1, ...JSON.parse(persistSignature) });
  }, [persistSignature]);

  useEffect(() => {
    const target = window as unknown as Record<string, unknown>;
    const forceFlush = () => flushCanvasSnapshot(true);
    target.__o8CanvasFlushSnapshot = forceFlush;
    window.addEventListener('beforeunload', forceFlush);
    return () => {
      if (target.__o8CanvasFlushSnapshot === forceFlush) delete target.__o8CanvasFlushSnapshot;
      window.removeEventListener('beforeunload', forceFlush);
    };
  }, [flushCanvasSnapshot]);

  useEffect(() => {
    // Hold fire until restore's async spawns settle — an instant save of
    // the half-restored canvas would overwrite the snapshot.
    if (!restoredRef.current || Date.now() < persistArmedAtRef.current) return;
    const timer = setTimeout(flushCanvasSnapshot, 700);
    return () => clearTimeout(timer);
  }, [flushCanvasSnapshot]);

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

  /** Rail Open file: native Tauri picker when present, visible path fallback otherwise. */
  const openFilePicker = useCallback(() => {
    setFilePathPickerOpen(false);
    setFilePickerBusy(true);
    void (async () => {
      if (isTauri()) {
        try {
          const { open } = await import('@tauri-apps/plugin-dialog');
          const chosen = await open({ multiple: false, directory: false, title: 'Open a file on the canvas' });
          const path = Array.isArray(chosen) ? chosen[0] : chosen;
          if (typeof path === 'string' && path) {
            openPathAsFileCard(path);
            return;
          }
          showCanvasToast('No file selected.', 'info');
          return;
        } catch {
          showCanvasToast('Native file picker unavailable. Enter a path instead.', 'error');
        }
      } else {
        showCanvasToast('Enter an absolute path to open a file card.', 'info');
      }
      setFilePathPickerOpen(true);
    })().finally(() => setFilePickerBusy(false));
  }, [openPathAsFileCard, showCanvasToast]);

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
   *  bottom edge dissolving into the canvas, aspect-locked resize.
   *  dataURI, not an object URL — the persistence snapshot stores items
   *  verbatim, and a blob: src is dead on the next reload. */
  const spawnImageCard = useCallback((file: File, at: { x: number; y: number }) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : null;
      if (!src) return;
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
      probe.src = src;
    };
    reader.readAsDataURL(file);
  }, []);

  const moveImageCard = useCallback((id: number, x: number, y: number) => {
    setImageCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
    // Live hit-test while dragging: highlight the photo we'd stack onto (the
    // topmost OTHER card whose bounds contain the dragged card's center).
    const cards = imageCardsRef.current;
    const dragged = cards.find((c) => c.id === id);
    if (!dragged) return;
    const cx = x + dragged.w / 2;
    const cy = y + dragged.h / 2;
    let tgt: number | null = null;
    for (const c of cards) {
      if (c.id === id) continue;
      if (cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h) tgt = c.id;
    }
    setDropTargetId(tgt);
  }, []);

  const resizeImageCard = useCallback((id: number, w: number, h: number) => {
    setImageCards((previous) => previous.map((card) => (
      card.id === id ? { ...card, w, h } : card
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
  const dropImageCard = useCallback((id: number) => {
    setDropTargetId(null);
    setImageCards((previous) => {
      const dragged = previous.find((card) => card.id === id);
      if (!dragged) return previous;
      // Hit-test in CANVAS coords from the dragged card's own geometry — the
      // SAME basis moveImageCard's live highlight uses. The drop once trusted
      // the pointer's SCREEN clientX/Y, which only matched canvas space at
      // zoom=1 / no pan and silently mis-targeted (or missed) the stack under
      // zoom or pan (#agent-surface-ergonomics coord smell).
      const centerX = dragged.x + dragged.w / 2;
      const centerY = dragged.y + dragged.h / 2;
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

  /** Flip a deck to the next (dir≥0) or previous (dir<0) photo, rotating the
   *  stack in place — tap and the ‹ › arrows both route here. items[0] is the
   *  visible top photo. */
  const cycleImageCard = useCallback((id: number, dir = 1) => {
    setImageCards((previous) => previous.map((card) => {
      if (card.id !== id || card.items.length < 2) return card;
      if (dir >= 0) {
        const [first, ...rest] = card.items;
        return { ...card, items: [...rest, first] };
      }
      const last = card.items[card.items.length - 1]!;
      return { ...card, items: [last, ...card.items.slice(0, -1)] };
    }));
  }, []);

  /** Separate a deck → spread its photos back into individual cards (the
   *  explicit un-stack control on a hovered deck). */
  const spreadImageCard = useCallback((id: number) => {
    setImageCards((previous) => {
      const stackCard = previous.find((card) => card.id === id);
      if (!stackCard || stackCard.items.length < 2) return previous;
      const spread: ImageCard[] = stackCard.items.slice(1).map((item, index) => {
        const spreadId = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return {
          id: spreadId,
          x: stackCard.x + 30 * (index + 1),
          y: stackCard.y + 22 * (index + 1),
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

  /** Drop a video clip onto the canvas — the bytes go to IndexedDB (a clip is
   *  far too big for the localStorage photos ride on), and the card renders an
   *  object URL minted from them. The snapshot keeps only the media id. */
  const spawnVideoCard = useCallback((file: File, at: { x: number; y: number }) => {
    const src = URL.createObjectURL(file);
    const mediaId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `vid-${Date.now()}-${nextIdRef.current}`;
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      const natW = probe.videoWidth || 16;
      const natH = probe.videoHeight || 9;
      const aspect = natW / natH;
      const w = natW >= natH ? IMG_MAX_SPAWN_EDGE : Math.round(IMG_MAX_SPAWN_EDGE * aspect);
      const h = Math.round(w / aspect);
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
      const z = zPeakRef.current;
      setVideoCards((previous) => [...previous, {
        id,
        x: Math.max(8, at.x - w / 2),
        y: Math.max(48, at.y - h / 2),
        z,
        w,
        h,
        aspect,
        src,
        name: file.name,
        mediaId,
      }]);
      void putMedia(mediaId, file);
    };
    probe.onerror = () => { URL.revokeObjectURL(src); };
    probe.src = src;
  }, []);

  const moveVideoCard = useCallback((id: number, x: number, y: number) => {
    setVideoCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeVideoCard = useCallback((id: number, w: number, h: number) => {
    setVideoCards((previous) => previous.map((card) => (
      card.id === id ? { ...card, w, h } : card
    )));
  }, []);

  // First-frame thumbnail from the card → stored on the card so the minimap can
  // render the video as a still (it can't decode the blob video URL as an image).
  const setVideoPoster = useCallback((id: number, poster: string) => {
    setVideoCards((previous) => previous.map((card) => (card.id === id ? { ...card, poster } : card)));
  }, []);

  const closeVideoCard = useCallback((id: number) => {
    setVideoCards((previous) => {
      const target = previous.find((card) => card.id === id);
      if (target) {
        URL.revokeObjectURL(target.src);
        void deleteMedia(target.mediaId);
      }
      return previous.filter((card) => card.id !== id);
    });
  }, []);

  const dropImages = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const all = Array.from(event.dataTransfer?.files ?? []);
    const videos = all.filter((file) => file.type.startsWith('video/'));
    const files = all.filter((file) => file.type.startsWith('image/'));
    // Drop point arrives in visual px — the card layer is zoomed.
    const z = canvasZoom();
    files.forEach((file, index) => {
      spawnImageCard(file, { x: event.clientX / z + index * 30, y: event.clientY / z + index * 24 });
    });
    videos.forEach((file, index) => {
      spawnVideoCard(file, { x: event.clientX / z + (files.length + index) * 30, y: event.clientY / z + (files.length + index) * 24 });
    });
  }, [spawnImageCard, spawnVideoCard]);

  /** Top-right search — first matching card on the canvas comes forward. */
  /** Search reaches EVERYTHING — every card kind on the canvas plus past
   *  sessions. Card hits come forward; session hits spawn as chat cards. */
  const searchHits = useMemo((): SearchHit[] => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];
    const matches = (value: string | null | undefined) => (value ?? '').toLowerCase().includes(query);
    const hits: SearchHit[] = [];
    termCards.forEach((card) => {
      if (matches(card.cwdLabel) || matches(card.sessionName)) hits.push({ kind: 'card', cardKind: 'term', id: card.id, title: card.cwdLabel ?? 'Terminal', meta: 'terminal · on the canvas' });
    });
    fileCards.forEach((card) => {
      if (matches(card.name) || matches(card.path)) hits.push({ kind: 'card', cardKind: 'file', id: card.id, title: card.name, meta: 'file · on the canvas' });
    });
    imageCards.forEach((card) => {
      const item = card.items.find((entry) => matches(entry.name));
      if (item) hits.push({ kind: 'card', cardKind: 'image', id: card.id, title: item.name, meta: 'image · on the canvas' });
    });
    browserCards.forEach((card) => {
      const tab = card.tabs.find((entry) => matches(entry.url));
      if (tab) hits.push({ kind: 'card', cardKind: 'browser', id: card.id, title: tab.url.replace(/^https?:\/\//i, ''), meta: 'browser tab · on the canvas' });
    });
    chatCards.forEach((card) => {
      if (matches(card.title) || matches(card.repoName)) hits.push({ kind: 'card', cardKind: 'chat', id: card.id, title: card.title, meta: `${card.repoName ?? 'chat'} · on the canvas` });
    });
    diffCards.forEach((card) => {
      if (matches(card.title) || matches(card.branch)) hits.push({ kind: 'card', cardKind: 'diff', id: card.id, title: card.title, meta: 'diff · on the canvas' });
    });
    specCards.forEach((card) => {
      const repoTail = card.repoPath?.split('/').pop() ?? null;
      if (matches('o8.md') || matches(repoTail)) hits.push({ kind: 'card', cardKind: 'spec', id: card.id, title: `o8.md${repoTail ? ` — ${repoTail}` : ''}`, meta: 'notes · on the canvas' });
    });
    brainCards.forEach((card) => {
      const repoTail = card.repoPath?.split('/').pop() ?? null;
      if (matches('brain') || matches(repoTail)) hits.push({ kind: 'card', cardKind: 'brain', id: card.id, title: `Brain${repoTail ? ` — ${repoTail}` : ''}`, meta: 'engineering brain · on the canvas' });
    });
    const openThreadIds = new Set(chatCards.map((card) => card.threadId));
    let threadHits = 0;
    for (const thread of recentThreads) {
      if (threadHits >= 8) break;
      if (openThreadIds.has(thread.id)) continue;
      if (!matches(thread.title) && !matches(thread.repoName)) continue;
      threadHits += 1;
      hits.push({
        kind: 'thread',
        threadId: thread.id,
        repoPath: thread.repoPath,
        repoName: thread.repoName,
        title: thread.title?.trim() || 'Untitled session',
        meta: [thread.repoName, relAge(thread.lastMessageAt)].filter(Boolean).join(' · ') || 'past session',
      });
    }
    return hits;
  }, [brainCards, browserCards, chatCards, diffCards, fileCards, imageCards, recentThreads, searchQuery, specCards, termCards]);

  const applySearchHit = useCallback((hit: SearchHit) => {
    if (hit.kind === 'card') focusCard(hit.cardKind, hit.id);
    else void pickThread(hit.threadId, hit.repoPath, { title: hit.title, repoName: hit.repoName });
    setSearchOpen(false);
    setSearchQuery('');
  }, [focusCard, pickThread]);

  // ── Canvas control surface (agent parity) ────────────────────────────────
  // The intent bus's card verbs let an agent drive the canvas the way a human
  // can: SEE every card (list), then move / resize / focus / close one by id.
  // focusCard + the per-kind close handlers (which own teardown — closeTerminal
  // kills the PTY, closeImageCard revokes the object URL) already exist; these
  // route to them so an agent's close behaves exactly like clicking the ✕.
  //
  // canvasCardsRef holds the latest card arrays so `list` + verb existence
  // checks read fresh state WITHOUT re-subscribing the intent listener on every
  // card change. Synced in an effect (not during render) — intents fire from
  // event handlers, long after commit, so one-tick lag never bites.
  const canvasCardsRef = useRef<Record<CanvasCardKind, CanvasCardLite[]>>({
    term: [], file: [], image: [], video: [], browser: [], chat: [], diff: [], spec: [], brain: [], markdown: [], agent: [],
  });
  useEffect(() => {
    canvasCardsRef.current = {
      term: termCards, file: fileCards, image: imageCards, video: videoCards, browser: browserCards,
      chat: chatCards, diff: diffCards, spec: specCards, brain: brainCards, markdown: markdownCards, agent: agentCards,
    };
  }, [termCards, fileCards, imageCards, videoCards, browserCards, chatCards, diffCards, specCards, brainCards, markdownCards, agentCards]);

  const canvasCardTitle = useCallback((kind: CanvasCardKind, card: CanvasCardLite): string => {
    switch (kind) {
      case 'term': return card.sessionName || (card.cwd ? `terminal · ${card.cwd}` : 'terminal');
      case 'file': return card.name || card.path || 'file';
      case 'image': return `${card.items?.length ?? 1} image${(card.items?.length ?? 1) === 1 ? '' : 's'}`;
      case 'video': return card.name || 'video';
      case 'browser': {
        const active = card.tabs?.find((t) => t.id === card.activeTabId) ?? card.tabs?.[0];
        return active?.title || active?.url || 'browser';
      }
      case 'chat': return card.title || 'session';
      case 'diff': return card.title || 'diff';
      case 'spec': return card.repoPath ? `spec · ${String(card.repoPath).split('/').pop()}` : 'o8.md';
      case 'brain': return card.initialQuestion || 'brain';
      case 'markdown': return card.title || 'note';
      case 'agent': return card.codename || card.title || `agent #${card.number ?? '?'}`;
      default: return kind;
    }
  }, []);

  const findCanvasCard = useCallback((kind: CanvasCardKind, id: number) => {
    return canvasCardsRef.current[kind].find((card) => card.id === id) ?? null;
  }, []);

  const canvasViewport = useCallback((nextZoom = canvasZoomLevel, nextPan?: { x: number; y: number }) => {
    const p = nextPan ?? pan;
    return {
      x: Math.round((0 - p.x) / nextZoom),
      y: Math.round((0 - p.y) / nextZoom),
      w: Math.round(winSize.w / nextZoom),
      h: Math.round(winSize.h / nextZoom),
      zoom: nextZoom,
    };
  }, [canvasZoomLevel, pan, winSize.h, winSize.w]);

  const animatePanTo = useCallback((target: { x: number; y: number }) => {
    if (panTweenRef.current !== null) cancelAnimationFrame(panTweenRef.current);
    const start = { ...pan };
    const started = performance.now();
    const duration = 350;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - t) ** 3;
      setPan({
        x: start.x + (target.x - start.x) * eased,
        y: start.y + (target.y - start.y) * eased,
      });
      if (t < 1) panTweenRef.current = requestAnimationFrame(tick);
      else panTweenRef.current = null;
    };
    panTweenRef.current = requestAnimationFrame(tick);
  }, [pan]);

  const capReadContent = useCallback((content: string) => {
    if (content.length <= CANVAS_READ_CAP) return { content, truncated: false };
    const head = content.slice(0, Math.floor(CANVAS_READ_CAP / 2));
    const tail = content.slice(content.length - Math.ceil(CANVAS_READ_CAP / 2));
    return { content: `${head}\n...\n${tail}`.slice(0, CANVAS_READ_CAP), truncated: true };
  }, []);

  const cardDomText = useCallback((id: number) => {
    const node = document.querySelector(`[data-card-id="${id}"]`) as HTMLElement | null;
    if (!node) return '';
    const textarea = node.querySelector('textarea') as HTMLTextAreaElement | null;
    if (textarea) return textarea.value;
    return node.innerText.trim();
  }, []);

  const dockEntryReadLine = useCallback((entry: DockEntry) => {
    if (entry.role === 'user') return `user: ${entry.text}`;
    if (entry.role === 'text') return `assistant: ${entry.text}`;
    if (entry.role === 'thinking') return `thinking: ${entry.text}`;
    if (entry.role === 'status') return `status: ${entry.text}`;
    if (entry.role === 'playback') return `playback: ${entry.text}`;
    if (entry.role === 'result') return `result: ${entry.title}${entry.body ? `\n${entry.body}` : ''}`;
    return '';
  }, []);

  const readCanvasCard = useCallback((kind: CanvasCardKind, card: CanvasCardLite, lines: number) => {
    let content = '';
    let truncated = false;
    if (kind === 'term') {
      if (!card.sessionName) return { ok: false, error: 'content-unavailable' };
      content = xtermHandlesRef.current.get(card.sessionName)?.readText(lines) ?? '';
      if (!content) return { ok: false, error: 'content-unavailable' };
    } else if (kind === 'chat') {
      const entries = (card.entries ?? []).slice(-lines);
      content = entries.map((entry) => {
        const role = typeof entry.role === 'string' ? entry.role : 'entry';
        const text = 'text' in entry && typeof entry.text === 'string'
          ? entry.text
          : 'body' in entry && typeof entry.body === 'string'
            ? entry.body
            : 'title' in entry && typeof entry.title === 'string'
              ? entry.title
              : JSON.stringify(entry);
        return `${role}: ${text}`;
      }).join('\n');
    } else if (kind === 'markdown') {
      content = card.markdown ?? '';
    } else if (kind === 'diff') {
      content = card.diff ?? '';
      truncated = Boolean(card.truncated);
    } else if (kind === 'file') {
      content = cardDomText(card.id);
      if (!content) return { ok: false, error: 'content-unavailable' };
    } else if (kind === 'brain') {
      content = cardDomText(card.id);
      if (!content || content.startsWith('Ask the Engineering Brain')) return { ok: false, error: 'content-unavailable' };
    } else if (kind === 'spec') {
      return { ok: false, error: 'unsupported-kind' };
    } else if (kind === 'browser') {
      const active = card.tabs?.find((tab) => tab.id === card.activeTabId) ?? card.tabs?.[0];
      return { ok: true, content: { url: active?.url ?? null, title: active?.title ?? canvasCardTitle(kind, card) }, truncated: false };
    } else if (kind === 'image') {
      return { ok: true, content: { items: card.items ?? [], count: card.items?.length ?? 0 }, truncated: false };
    } else if (kind === 'video') {
      return { ok: true, content: { src: card.src ?? null, name: card.name ?? null, mediaId: card.mediaId ?? null, poster: Boolean(card.poster) }, truncated: false };
    } else if (kind === 'agent') {
      const lane = activeLanes.find((row) => row.id === card.laneId) ?? null;
      const phase = phaseFor(lane?.status ?? 'done');
      const transcriptKey = lane?.repoPath ?? card.repoPath ?? null;
      const transcript = (transcriptKey ? convos[transcriptKey] : undefined) ?? [];
      const transcriptTail = transcript.slice(-lines).map(dockEntryReadLine).filter(Boolean);
      content = [
        `phase: ${phase.label}`,
        `status: ${lane?.status ?? 'done'}`,
        `task: ${card.title ?? ''}`,
        `repo: ${lane?.repoPath ?? ''}`,
        `runtime: ${lane?.runtime ?? card.runtime ?? ''}`,
        transcriptTail.length ? `transcript:\n${transcriptTail.join('\n')}` : '',
      ].filter(Boolean).join('\n');
    } else {
      return { ok: false, error: 'unsupported-kind' };
    }
    const capped = capReadContent(content);
    return { ok: true, content: capped.content, truncated: truncated || capped.truncated };
  }, [activeLanes, canvasCardTitle, capReadContent, cardDomText, convos, dockEntryReadLine]);

  const patchCanvasCardGeom = useCallback((kind: CanvasCardKind, id: number, patch: { x?: number; y?: number; w?: number; h?: number }) => {
    switch (kind) {
      case 'term': setTermCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'file': setFileCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'image': setImageCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'video': setVideoCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'browser': setBrowserCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'chat': setChatCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'diff': setDiffCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'spec': setSpecCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'brain': setBrainCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'markdown': setMarkdownCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
      case 'agent': setAgentCards((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c))); break;
    }
  }, []);

  const dismissCanvasCard = useCallback((kind: CanvasCardKind, id: number) => {
    switch (kind) {
      case 'term': {
        const card = canvasCardsRef.current.term.find((c) => c.id === id);
        if (card) closeTerminal(card as unknown as TermCard);
        break;
      }
      case 'file': closeFileCard(id); break;
      case 'image': closeImageCard(id); break;
      case 'video': closeVideoCard(id); break;
      case 'browser': closeBrowserCard(id); break;
      case 'chat': closeChatCard(id); break;
      case 'diff': setDiffCards((p) => p.filter((c) => c.id !== id)); break;
      case 'spec': setSpecCards((p) => p.filter((c) => c.id !== id)); break;
      case 'brain': setBrainCards((p) => p.filter((c) => c.id !== id)); break;
      case 'markdown': setMarkdownCards((p) => p.filter((c) => c.id !== id)); break;
      case 'agent': setAgentCards((p) => p.filter((c) => c.id !== id)); break;
    }
  }, [closeTerminal, closeFileCard, closeImageCard, closeVideoCard, closeBrowserCard, closeChatCard]);

  // Canvas intent bus (#1232 phase 2) — Symon and the gated /api/canvas/intent
  // route drive the canvas through the SAME handlers the rail buttons call.
  // Listeners run synchronously on dispatchEvent, so the ack stamped on
  // window.__o8CanvasIntentLast is readable right after dispatch.
  useEffect(() => {
    if (!canvasEnabled) return;
    const onIntent = (event: Event) => {
      const detail = (event as CustomEvent<{ verb?: string; args?: Record<string, unknown>; origin?: string | null }>).detail ?? {};
      const args = (detail.args && typeof detail.args === 'object' ? detail.args : {}) as Record<string, unknown>;
      const origin = detail.origin === 'symon' ? 'symon' : null;
      let ok = true;
      let note: string | null = null;
      let error: string | null = null;
      let data: unknown = undefined;
      try {
        switch (detail.verb) {
          case 'open-browser':
            window.dispatchEvent(new CustomEvent('o8:open-browser', { detail: { url: typeof args.url === 'string' ? args.url : null } }));
            break;
          case 'ask-brain':
            spawnBrainCard(typeof args.question === 'string' ? args.question : undefined);
            break;
          case 'render': {
            // Render-on-screen (#1270) — the orchestrator paints a markdown
            // explainer onto the canvas ("explain X on my screen").
            const title = typeof args.title === 'string' ? args.title.trim() : '';
            const markdown = typeof args.markdown === 'string' ? args.markdown : '';
            if (!markdown.trim()) {
              ok = false;
              note = 'render needs args.markdown';
            } else {
              spawnMarkdownCard(title, markdown);
              note = title ? `rendered "${title}"` : 'rendered note';
            }
            break;
          }
          case 'open-spec':
            spawnSpecCard();
            break;
          case 'spawn-terminal': {
            const path = activeRepoPath ?? null;
            spawnTerminal(path, path ? repos?.find((repo) => repo.path === path)?.name ?? null : null);
            break;
          }
          case 'search':
            setSearchOpen(true);
            if (typeof args.query === 'string') setSearchQuery(args.query);
            break;
          case 'zoom': {
            const level = typeof args.level === 'number' ? args.level : NaN;
            if (ZOOM_STEPS.some((step) => step.value === level)) {
              setCanvasZoomLevel(level);
            } else if (args.direction === 'in' || args.direction === 'out') {
              setCanvasZoomLevel((previous) => {
                const index = ZOOM_STEPS.findIndex((step) => step.value === previous);
                const next = args.direction === 'out' ? index + 1 : index - 1;
                return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, next))].value;
              });
            } else {
              ok = false;
              note = `zoom needs level (${ZOOM_STEPS.map((step) => step.value).join(', ')}) or direction in|out`;
            }
            break;
          }
          case 'enter':
            // "open / enter / show the canvas" — the route's ensure:true already
            // navigated here before dispatching, so the Canvas is up. Nothing
            // else to do; ack ok so Symon can confirm "the canvas is up".
            break;
          case 'dock':
            if (typeof args.open === 'boolean') setDockOpen(args.open);
            else setDockOpen((previous) => !previous);
            break;
          case 'send-prompt': {
            const text = typeof args.text === 'string' ? args.text.trim() : '';
            if (!text) {
              ok = false;
              note = 'send-prompt needs args.text';
            } else if (!sendPrompt(text)) {
              ok = false;
              note = 'orchestrator not ready — no repo scoped, busy, or not connected';
            }
            break;
          }
          case 'spawn-agents': {
            // Gateless worktree spawn — "spawn two agents on the auth refactor".
            // The created lanes bloom as numbered cards via the lane watcher.
            const task = typeof args.task === 'string' ? args.task : (typeof args.text === 'string' ? args.text : '');
            const count = typeof args.count === 'number' ? args.count : 1;
            const repo = typeof args.repo === 'string' ? args.repo : null;
            const failure = spawnAgents(task, count, repo, origin);
            if (failure) {
              ok = false;
              note = failure;
            } else {
              const n = Math.max(1, Math.min(5, Math.floor(count) || 1));
              note = `spawning ${n} agent${n === 1 ? '' : 's'}`;
            }
            break;
          }
          case 'grid': {
            // "grid mode" / "tile the agents" — form-fit every canvas card into a
            // grid (the demo's auto-arrange). `on` boolean sets it; omit to toggle.
            // The ack note reflects the RESULTING state (read from the closure) so
            // a spoken toggle never reports the wrong mode back to the operator.
            const explicit = typeof args.on === 'boolean' ? args.on
              : typeof args.enabled === 'boolean' ? args.enabled
              : null;
            const next = explicit === null ? !gridMode : explicit;
            setGridMode(next);
            note = next ? 'grid mode' : 'free canvas';
            break;
          }
          case 'list': {
            // Sight — the canvas card inventory so an agent can act on ids, not
            // pixels. Read from the ref (latest arrays) so this never goes stale.
            const cards: Array<Record<string, unknown>> = [];
            for (const k of CANVAS_CARD_KINDS) {
              for (const c of canvasCardsRef.current[k]) {
                cards.push({ kind: k, id: c.id, x: Math.round(c.x), y: Math.round(c.y), z: c.z, w: Math.round(c.w), h: Math.round(c.h), title: canvasCardTitle(k, c) });
              }
            }
            data = { cards, count: cards.length, zoom: canvasZoomLevel, grid: gridMode, dock: dockOpen, activeRepo: activeRepoPath ?? null, viewport: canvasViewport() };
            note = `${cards.length} card${cards.length === 1 ? '' : 's'} on canvas`;
            break;
          }
          case 'center-on-card':
          case 'read-card': {
            const kind = (typeof args.kind === 'string' ? args.kind : '') as CanvasCardKind;
            const rawId = args.id;
            const id = typeof rawId === 'number' ? rawId : (typeof rawId === 'string' && rawId.trim() ? Number(rawId) : NaN);
            if (!CANVAS_CARD_KINDS.includes(kind) || !Number.isFinite(id)) {
              ok = false;
              error = 'invalid-args';
              note = `${detail.verb} needs args.kind (one of ${CANVAS_CARD_KINDS.join(', ')}) and a numeric args.id — call list first`;
              break;
            }
            const card = findCanvasCard(kind, id);
            if (!card) {
              ok = false;
              error = 'not-found';
              note = 'not-found';
              data = { ok: false, error: 'not-found' };
              break;
            }
            if (detail.verb === 'center-on-card') {
              let nextZoom = canvasZoomLevel;
              const zoomArg = typeof args.zoom === 'number' && Number.isFinite(args.zoom) ? args.zoom : null;
              if (zoomArg !== null) {
                nextZoom = ZOOM_STEPS.reduce((best, step) => (
                  Math.abs(step.value - zoomArg) < Math.abs(best.value - zoomArg) ? step : best
                ), ZOOM_STEPS[0]).value;
                setCanvasZoomLevel(nextZoom);
              }
              animatePanTo({
                x: winSize.w / 2 - (card.x + card.w / 2) * nextZoom,
                y: winSize.h / 2 - (card.y + card.h / 2) * nextZoom,
              });
              data = { ok: true, centered: { kind, id } };
              note = `centered ${kind} ${id}`;
            } else {
              const lines = typeof args.lines === 'number' && Number.isFinite(args.lines) ? Math.max(1, Math.floor(args.lines)) : 40;
              const read = readCanvasCard(kind, card, lines);
              ok = read.ok;
              error = read.ok ? null : (read.error ?? 'read-card-failed');
              data = read.ok
                ? { ok: true, kind, id, title: canvasCardTitle(kind, card), content: read.content, truncated: read.truncated }
                : { ok: false, kind, id, error: read.error };
              note = read.ok ? `read ${kind} ${id}` : (read.error ?? 'read-card failed');
            }
            break;
          }
          case 'pan': {
            const dx = typeof args.dx === 'number' ? args.dx : null;
            const dy = typeof args.dy === 'number' ? args.dy : null;
            const x = typeof args.x === 'number' ? args.x : null;
            const y = typeof args.y === 'number' ? args.y : null;
            if (dx !== null && dy !== null) {
              const target = { x: pan.x + dx, y: pan.y + dy };
              animatePanTo(target);
              data = { ok: true, viewport: canvasViewport(canvasZoomLevel, target) };
              note = 'panned canvas';
            } else if (x !== null && y !== null) {
              const target = { x, y };
              animatePanTo(target);
              data = { ok: true, viewport: canvasViewport(canvasZoomLevel, target) };
              note = 'panned canvas';
            } else {
              ok = false;
              error = 'invalid-args';
              note = 'pan needs numeric args.dx/dy or numeric args.x/y';
            }
            break;
          }
          case 'move-card':
          case 'resize-card':
          case 'focus-card':
          case 'close-card': {
            // Address a card by (kind, id) — ids come from `list`. Every verb
            // validates the card exists first so an agent gets a clear miss note
            // instead of a silent no-op.
            const kind = (typeof args.kind === 'string' ? args.kind : '') as CanvasCardKind;
            const id = typeof args.id === 'number' ? args.id : Number(args.id);
            if (!CANVAS_CARD_KINDS.includes(kind) || !Number.isFinite(id)) {
              ok = false;
              note = `${detail.verb} needs args.kind (one of ${CANVAS_CARD_KINDS.join(', ')}) and a numeric args.id — call list first`;
              break;
            }
            const card = canvasCardsRef.current[kind].find((c) => c.id === id);
            if (!card) {
              ok = false;
              note = `no ${kind} card with id ${id} on the canvas (call list to see current ids)`;
              break;
            }
            if (detail.verb === 'move-card') {
              const x = Number(args.x);
              const y = Number(args.y);
              if (!Number.isFinite(x) || !Number.isFinite(y)) {
                ok = false;
                note = 'move-card needs numeric args.x and args.y (canvas-layer coordinates)';
                break;
              }
              patchCanvasCardGeom(kind, id, { x, y });
              note = `moved ${kind} ${id} to (${Math.round(x)}, ${Math.round(y)})`;
            } else if (detail.verb === 'resize-card') {
              const w = Number(args.w);
              const h = Number(args.h);
              if (!Number.isFinite(w) || !Number.isFinite(h)) {
                ok = false;
                note = 'resize-card needs numeric args.w and args.h';
                break;
              }
              if ((kind === 'image' || kind === 'video') && card.aspect) {
                // Photos + video stay aspect-locked (like the human resize); honor
                // width and derive height so the agent can't distort the media.
                const nw = Math.max(CANVAS_GEOM_FLOOR, w);
                patchCanvasCardGeom(kind, id, { w: nw, h: Math.round(nw / card.aspect) });
              } else {
                patchCanvasCardGeom(kind, id, { w: Math.max(CANVAS_GEOM_FLOOR, w), h: Math.max(CANVAS_GEOM_FLOOR, h) });
              }
              note = `resized ${kind} ${id}`;
            } else if (detail.verb === 'focus-card') {
              focusCard(kind, id);
              note = `focused ${kind} ${id}`;
            } else {
              dismissCanvasCard(kind, id);
              note = `closed ${kind} ${id}`;
            }
            break;
          }
          case 'add-image': {
            // Put a photo on the canvas from a URL/served path — the verb a voice
            // or agent operator needs (humans drag a File; agents pass a src).
            const src = typeof args.src === 'string' ? args.src : typeof args.url === 'string' ? args.url : '';
            if (!src) { ok = false; note = 'add-image needs args.src (a URL or /served path the canvas can load)'; break; }
            const name = typeof args.name === 'string' ? args.name : (src.split('/').pop() || 'image');
            const ax = typeof args.x === 'number' ? args.x : 80;
            const ay = typeof args.y === 'number' ? args.y : 80;
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
              setImageCards((prev) => [...prev, { id, x: ax, y: ay, z: zPeakRef.current, w, h, aspect, items: [{ src, name }] }]);
            };
            probe.src = src;
            note = `adding image ${name}`;
            break;
          }
          case 'stack': {
            // Group image cards into one deck (the agent twin of drag-together).
            const ids: number[] = Array.isArray(args.ids)
              ? (args.ids as unknown[]).map(Number).filter((n) => Number.isFinite(n))
              : [args.id, args.ontoId].map(Number).filter((n) => Number.isFinite(n));
            const present = ids.filter((id) => imageCardsRef.current.some((c) => c.id === id));
            if (present.length < 2) { ok = false; note = 'stack needs ≥2 existing image ids (args.ids or args.id + args.ontoId — call list for ids)'; break; }
            setImageCards((prev) => {
              const base = prev.find((c) => c.id === present[0]);
              if (!base) return prev;
              const items = present.map((id) => prev.find((c) => c.id === id)).filter((c): c is ImageCard => Boolean(c)).flatMap((c) => c.items);
              const drop = new Set(present.slice(1));
              return prev.filter((c) => !drop.has(c.id)).map((c) => (c.id === base.id ? { ...c, items } : c));
            });
            note = `stacked ${present.length} images`;
            break;
          }
          case 'flip': {
            const id = Number(args.id);
            const deck = imageCardsRef.current.find((c) => c.id === id);
            if (!deck) { ok = false; note = `no image card with id ${id} (call list for ids)`; break; }
            if (deck.items.length < 2) { ok = false; note = `image ${id} isn't a deck (only ${deck.items.length} photo)`; break; }
            const dir = Number(args.dir) < 0 ? -1 : 1;
            cycleImageCard(id, dir);
            note = `flipped deck ${id} to ${dir < 0 ? 'previous' : 'next'}`;
            break;
          }
          case 'separate': {
            const id = Number(args.id);
            const deck = imageCardsRef.current.find((c) => c.id === id);
            if (!deck) { ok = false; note = `no image card with id ${id} (call list for ids)`; break; }
            if (deck.items.length < 2) { ok = false; note = `image ${id} isn't a deck — nothing to separate`; break; }
            spreadImageCard(id);
            note = `separated deck ${id} into ${deck.items.length} cards`;
            break;
          }
          case 'add-file': {
            // Put a repo file on the canvas (CodeMirror editor card). file-io
            // needs an ABSOLUTE path, so reject relative ones with a clear note.
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            if (!path) { ok = false; note = 'add-file needs args.path (an absolute file path)'; break; }
            if (!path.startsWith('/')) { ok = false; note = 'add-file path must be absolute (start with /)'; break; }
            const at = (typeof args.x === 'number' && typeof args.y === 'number') ? { x: args.x, y: args.y, w: 620, h: 420 } : undefined;
            spawnFileCard(path, at);
            note = `added file ${path.split('/').pop() || path}`;
            break;
          }
          case 'open-diff': {
            // The active repo's working-tree diff ("what have I changed") — the
            // fixture-free diff an agent can always show. Lane diffs go through
            // o8_packet_diff, not here.
            const repo = typeof args.repo === 'string' ? args.repo : (activeRepoPath ?? '');
            if (!repo) { ok = false; note = 'open-diff needs a repo (no active repo scoped — pass args.repo)'; break; }
            void spawnWorktreeDiffCard(undefined, repo);
            note = `opened working-tree diff for ${repo.split('/').filter(Boolean).pop() ?? repo}`;
            break;
          }
          case 'open-chat': {
            // Reopen a past orchestrator thread as a chat card (replays history).
            const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
            if (!threadId) { ok = false; note = 'open-chat needs args.threadId (a past thread id)'; break; }
            const repo = typeof args.repo === 'string' ? args.repo : (activeRepoPath ?? null);
            void pickThread(threadId, repo);
            note = `opened chat thread ${threadId}`;
            break;
          }
          case 'add-video': {
            // Put a video on the canvas from a URL/served path — fetched into a
            // File so it rides the same IndexedDB-backed path as a human drop.
            const src = typeof args.src === 'string' ? args.src.trim() : '';
            if (!src) { ok = false; note = 'add-video needs args.src (a video URL/served path)'; break; }
            const vname = typeof args.name === 'string' ? args.name : (src.split('/').pop() || 'video');
            const vx = typeof args.x === 'number' ? args.x : 320;
            const vy = typeof args.y === 'number' ? args.y : 260;
            void fetch(src)
              .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
              .then((blob) => spawnVideoCard(new File([blob], vname, { type: blob.type || 'video/mp4' }), { x: vx, y: vy }))
              .catch(() => {});
            note = `adding video ${vname}`;
            break;
          }
          default:
            ok = false;
            note = `unknown intent verb: ${String(detail.verb)}`;
        }
      } catch (caught) {
        ok = false;
        error = 'exception';
        note = caught instanceof Error ? caught.message : String(caught);
      }
      (window as unknown as Record<string, unknown>).__o8CanvasIntentLast = { verb: detail.verb ?? null, ok, note, ...(error ? { error } : {}), ...(data !== undefined ? { data } : {}), at: Date.now() };
    };
    window.addEventListener('o8:canvas-intent', onIntent);
    (window as unknown as Record<string, unknown>).__o8CanvasIntentReady = true;
    return () => {
      window.removeEventListener('o8:canvas-intent', onIntent);
      (window as unknown as Record<string, unknown>).__o8CanvasIntentReady = false;
    };
  }, [activeRepoPath, animatePanTo, canvasEnabled, canvasViewport, canvasZoomLevel, dockOpen, findCanvasCard, gridMode, pan.x, pan.y, readCanvasCard, repos, sendPrompt, spawnAgents, spawnBrainCard, spawnMarkdownCard, spawnSpecCard, spawnTerminal, spawnFileCard, spawnWorktreeDiffCard, spawnVideoCard, pickThread, cycleImageCard, spreadImageCard, canvasCardTitle, patchCanvasCardGeom, dismissCanvasCard, focusCard, winSize.h, winSize.w]);

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
  // Composer dispatch dock — real dispatched packets, or the dev demo seed when
  // one is set (so the motion is visible with nothing actually running).
  const dispatchLanes: DispatchLane[] = activeLanes;

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
      <style>{CARD_ENTRANCE.keyframes}</style>
      {/* Realtime voice host — also mounted here (not just the dashboard) so the
          full-page nav into the canvas auto-resumes the session via the handoff
          instead of going silent. Renders only its own fixed pill. */}
      <RealtimeVoiceHost />
      <SymonVoicePresencePill />

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
          backgroundImage: 'radial-gradient(circle, var(--cnv-bg-dot, rgba(255,255,255,0.055)) 1px, transparent 1.4px)',
          backgroundSize: '26px 26px',
          pointerEvents: 'none',
          zIndex: 1,
          // Drag-flicker fix: a moving backdrop-filter card forces WebKit to
          // re-rasterize its repaint region, which includes this full-screen
          // veil. Without its own compositor layer the veil drops a frame and
          // the dark native vibrancy (HudWindow) flashes through. Pin it to a
          // persistent, isolated GPU layer so card movement never re-paints it.
          transform: 'translateZ(0)',
          willChange: 'transform',
          backfaceVisibility: 'hidden',
          WebkitBackfaceVisibility: 'hidden',
          isolation: 'isolate',
        } as React.CSSProperties}
      />

      {/* Depth layer — the paper/shader mood from the Canvas tuner. */}
      <CanvasBackdropLayer kind={settings.backdrop} tone={settings.tone} />

      {/* Center emblem retired (operator call 2026-06-12) — the empty
          canvas stays clean; a logo / Lottie motion piece comes later. */}

      {/* ── The card layer — CSS-zoomed as one unit. Chrome (top dock,
            rails, composer, drawers) stays at 1:1; only the workspace
            scales, buying breathing room around the cards. Drag/resize
            handlers divide pointer deltas by the zoom (canvasZoom()). */}
      <div data-canvas-layer style={{ position: 'absolute', inset: 0, zIndex: 2, zoom: canvasZoomLevel, transform: `translate(${pan.x}px, ${pan.y}px)`, willChange: 'transform' } as React.CSSProperties}>

      {/* ── Grid drag placeholder — the ghost slot the lifted card will land in.
            Sits behind the cards in the hole they reflow open; glides between
            slots as the target changes. ─────────────────────────────────── */}
      {gridPlaceholder ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: gridPlaceholder.x,
            top: gridPlaceholder.y,
            width: gridPlaceholder.w,
            height: gridPlaceholder.h,
            borderRadius: 22,
            border: '2px dashed var(--cnv-ink-muted)',
            background: 'rgba(255, 255, 255, 0.04)',
            opacity: 0.6,
            zIndex: 0,
            pointerEvents: 'none',
            transition: 'left 130ms ease, top 130ms ease, width 130ms ease, height 130ms ease',
          }}
        />
      ) : null}

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
            to stack, tap a deck to flip through ─────────────────────── */}
      <AnimatePresence>
        {imageCards.map((card) => (
          <ImageGlassCard
            key={card.id}
            card={card}
            isDropTarget={card.id === dropTargetId}
            onMove={moveImageCard}
            onResize={resizeImageCard}
            onFocus={focusImageCard}
            onDrop={dropImageCard}
            onTap={cycleImageCard}
            onCycle={cycleImageCard}
            onSpread={spreadImageCard}
            onClose={closeImageCard}
          />
        ))}
      </AnimatePresence>

      {/* ── Video cards — UI clips that sit on the canvas for reference ── */}
      <AnimatePresence>
        {videoCards.map((card) => (
          <VideoGlassCard
            key={card.id}
            card={card}
            onMove={moveVideoCard}
            onResize={resizeVideoCard}
            onFocus={focusVideoCard}
            onClose={closeVideoCard}
            onPoster={setVideoPoster}
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

      {/* ── Agent cards — dispatched workers as canvas objects (voice spawn) ─ */}
      <AnimatePresence>
        {agentCards.map((card) => (
          <AgentGlassCard
            key={card.id}
            card={card}
            lane={activeLanes.find((lane) => lane.id === card.laneId) ?? null}
            onMove={(id, x, y) => setAgentCards((previous) => previous.map((c) => (c.id === id ? { ...c, x, y } : c)))}
            onResize={(id, w, h) => setAgentCards((previous) => previous.map((c) => (c.id === id ? { ...c, w, h } : c)))}
            onFocus={focusAgentCard}
            onClose={(id) => setAgentCards((previous) => previous.filter((c) => c.id !== id))}
            onReview={(laneId) => {
              const lane = activeLanes.find((row) => row.id === laneId);
              if (lane) void spawnDiffCard(lane);
            }}
            onToggleExpand={toggleAgentCardExpand}
          />
        ))}
      </AnimatePresence>

      {/* o8.md cards render in a SEPARATE overlay OUTSIDE this zoom layer (just
          after it) — CodeMirror caret hit-testing breaks under any CSS scale, so
          they render at true device-1:1 and scale numerically instead (#1241). */}

      {/* ── Brain cards — instant cited repo answers, on the canvas ── */}
      <AnimatePresence>
        {brainCards.map((card) => (
          <BrainGlassCard
            key={card.id}
            card={card}
            onMove={(id, x, y) => setBrainCards((previous) => previous.map((c) => (c.id === id ? { ...c, x, y } : c)))}
            onResize={(id, w, h) => setBrainCards((previous) => previous.map((c) => (c.id === id ? { ...c, w, h } : c)))}
            onFocus={focusBrainCard}
            onClose={(id) => setBrainCards((previous) => previous.filter((c) => c.id !== id))}
          />
        ))}
      </AnimatePresence>

      {/* ── Markdown cards — orchestrator-rendered explainers (#1270) ── */}
      <AnimatePresence>
        {markdownCards.map((card) => (
          <MarkdownGlassCard
            key={card.id}
            card={card}
            onMove={(id, x, y) => setMarkdownCards((previous) => previous.map((c) => (c.id === id ? { ...c, x, y } : c)))}
            onResize={(id, w, h) => setMarkdownCards((previous) => previous.map((c) => (c.id === id ? { ...c, w, h } : c)))}
            onFocus={focusMarkdownCard}
            onClose={(id) => setMarkdownCards((previous) => previous.filter((c) => c.id !== id))}
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
            onTruncate={truncateLane}
            onMove={moveChatCard}
            onResize={resizeChatCard}
            onFocus={focusChatCard}
            onDock={dockChatCard}
            onClose={closeChatCard}
          />
        ))}
      </AnimatePresence>

      </div>

      {/* ── o8.md overlay — OUTSIDE the zoom layer so CodeMirror renders at true
            device-1:1 (WebKit caret hit-testing breaks under ANY CSS scale in
            the ancestry — even a nested counter-scale to net-1.0; proven). Each
            card maps its layer-local x/y to screen via screenMap = zoom·(coord+
            pan) and scales its own size + chrome + editor NUMERICALLY by the
            zoom, so it looks identical to an in-layer card but the caret works
            everywhere (#1241). Container is pointerEvents:none (empty canvas
            stays clickable); each card opts back in. zIndex 3 = above the canvas
            layer (2), below the chrome (40+). */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' } as React.CSSProperties}>
        <AnimatePresence>
          {specCards.map((card) => (
            <SpecGlassCard
              key={card.id}
              card={card}
              screenMap={{ zoom: canvasZoomLevel, panX: pan.x, panY: pan.y }}
              onMove={(id, x, y) => setSpecCards((previous) => previous.map((c) => (c.id === id ? { ...c, x, y } : c)))}
              onResize={(id, w, h) => setSpecCards((previous) => previous.map((c) => (c.id === id ? { ...c, w, h } : c)))}
              onFocus={focusSpecCard}
              onClose={(id) => setSpecCards((previous) => previous.filter((c) => c.id !== id))}
            />
          ))}
        </AnimatePresence>
      </div>

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
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            paddingRight: 0,
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
          badge={inboxItems.filter((item) => !seenAlerts.has(item.id)).length}
          onClick={() => setTopMenu((value) => (value === 'alerts' ? null : 'alerts'))}
          path="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"
        />
        <DockGlyphButton
          label="Orchestrators"
          active={dockOpen}
          onClick={() => (dockOpen ? undockToCard() : redockActiveLane())}
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
            paddingTop: 0,
            paddingBottom: 0,
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
                {topMenu === 'agents' ? 'Running agents' : 'Alerts'}
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
                  All clear — nothing needs you.
                </span>
              ) : (
                inboxItems.slice(0, 10).map((item) => {
                  const seen = seenAlerts.has(item.id);
                  return (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => jumpToAlert(item)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      borderWidth: 0,
                      background: 'transparent',
                      cursor: 'pointer',
                      borderRadius: 8,
                      paddingTop: 6,
                      paddingBottom: 6,
                      paddingLeft: 8,
                      paddingRight: 8,
                      fontFamily: FONT,
                      opacity: seen ? 0.5 : 1,
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        flexShrink: 0,
                        marginTop: 4,
                        background: seen
                          ? 'rgba(255,255,255,0.22)'
                          : item.severity === 'critical' || item.severity === 'high'
                            ? '#ef4444'
                            : item.kind === 'approval' || item.severity === 'warning'
                              ? '#f59e0b'
                              : 'rgba(255,255,255,0.4)',
                      }}
                    />
                    <span style={{ display: 'flex', flex: 1, flexDirection: 'column', gap: 1, minWidth: 0, fontFamily: FONT }}>
                      <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </span>
                      {item.detail ? (
                        <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.detail}
                        </span>
                      ) : null}
                    </span>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, marginTop: 3, opacity: 0.4 }}>
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                  );
                })
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
        <ViewAsFreeIndicator palette="canvas" />
        <CanvasFeedbackButton />
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
          aria-label="Account"
          onClick={() => setTopMenu((value) => (value === 'profile' ? null : 'profile'))}
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: topMenu === 'profile' ? 'var(--cnv-ink-muted)' : 'var(--cnv-edge)',
            backgroundColor: auth.signedIn && auth.user?.avatarUrl ? 'transparent' : 'var(--cnv-tint)',
            backgroundImage: auth.signedIn && auth.user?.avatarUrl ? `url("${auth.user.avatarUrl}")` : undefined,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: topMenu === 'profile' ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
            flexShrink: 0,
            cursor: 'pointer',
            overflow: 'hidden',
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            paddingRight: 0,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
          onMouseLeave={(event) => { if (topMenu !== 'profile') event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
        >
          {auth.signedIn && auth.user?.avatarUrl ? null : (
            <svg style={{ width: 12, height: 12, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
            </svg>
          )}
        </button>
      </div>

      {/* Account dossier — the Clerk sign-in popover (operator's reference). */}
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
                width: 268,
                display: 'flex',
                flexDirection: 'column',
                paddingTop: 14,
                paddingBottom: 10,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 16,
                zIndex: 46,
                fontFamily: FONT,
                ...glassPop(),
              }}
            >
              {auth.signedIn && auth.user ? (
                <>
                  {/* Identity — avatar, name, email. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 2, paddingRight: 2, paddingBottom: 12 }}>
                    <div
                      aria-hidden
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        flexShrink: 0,
                        backgroundColor: 'var(--cnv-tint)',
                        backgroundImage: auth.user.avatarUrl ? `url("${auth.user.avatarUrl}")` : undefined,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        border: '1px solid var(--cnv-edge)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--cnv-ink-muted)',
                      }}
                    >
                      {auth.user.avatarUrl ? null : (
                        <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                        </svg>
                      )}
                    </div>
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {auth.user.name || 'Account'}
                      </span>
                      {auth.user.email ? (
                        <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {auth.user.email}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div aria-hidden style={{ height: 1, background: 'var(--cnv-edge)', marginLeft: 2, marginRight: 2, marginBottom: 6 }} />
                  <button
                    type="button"
                    onClick={() => { auth.openManageAccount(); setTopMenu(null); }}
                    style={DOSSIER_ROW}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={DOSSIER_TILE} aria-hidden>
                      <svg style={{ width: 15, height: 15 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 6.5v9L12 20l8-4.5v-9L12 2Z" /><circle cx="12" cy="11.5" r="2.6" /></svg>
                    </span>
                    Manage account
                  </button>
                  <button
                    type="button"
                    onClick={() => { void auth.signOut(); setTopMenu(null); }}
                    style={DOSSIER_ROW}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={DOSSIER_TILE} aria-hidden>
                      <svg style={{ width: 15, height: 15 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
                    </span>
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  {/* Signed-out / not-yet-configured — the sign-in door. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 2, paddingRight: 2, paddingBottom: 12 }}>
                    <div aria-hidden style={{ width: 40, height: 40, borderRadius: 12, flexShrink: 0, background: 'var(--cnv-tint)', border: '1px solid var(--cnv-edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cnv-ink-muted)' }}>
                      <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: '-0.1px', color: 'var(--cnv-ink)' }}>Sign in</span>
                      <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', lineHeight: 1.45 }}>
                        {auth.clerkEnabled ? 'Sync your identity across desktop and web.' : 'Activates once sign-in keys are set.'}
                      </span>
                    </div>
                  </div>
                  <div aria-hidden style={{ height: 1, background: 'var(--cnv-edge)', marginLeft: 2, marginRight: 2, marginBottom: 6 }} />
                  <button
                    type="button"
                    onClick={() => { auth.signIn(); setTopMenu(null); }}
                    style={DOSSIER_ROW}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={DOSSIER_TILE} aria-hidden>
                      <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.339-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.523 2 12 2Z" /></svg>
                    </span>
                    Sign in with GitHub
                  </button>
                </>
              )}
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
              width: 300,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 16,
              zIndex: 41,
              overflow: 'hidden',
              ...glassPop(),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 36, paddingLeft: 12, paddingRight: 12 }}>
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && searchHits.length > 0) applySearchHit(searchHits[0]);
                  if (event.key === 'Escape') setSearchOpen(false);
                }}
                placeholder="Cards on the canvas + past sessions"
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
            </div>
            {searchQuery.trim() ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 6, paddingBottom: 8, paddingLeft: 6, paddingRight: 6, borderTop: '1px solid var(--cnv-edge)', maxHeight: 300, overflowY: 'auto', scrollbarWidth: 'none' } as React.CSSProperties}>
                {searchHits.length === 0 ? (
                  <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingTop: 4, paddingBottom: 4, paddingLeft: 8 }}>
                    No matches — cards or past sessions.
                  </span>
                ) : (
                  searchHits.slice(0, 12).map((hit) => (
                    <button
                      key={hit.kind === 'card' ? `card:${hit.cardKind}:${hit.id}` : `thread:${hit.threadId}`}
                      type="button"
                      onClick={() => applySearchHit(hit)}
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: 'pointer', fontFamily: FONT, textAlign: 'left', width: '100%' }}
                      onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                        {hit.title}
                      </span>
                      <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                        {hit.meta}
                      </span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Left spawn dock — the component vocabulary ───────────── */}
      <ProximityDock
        axis="y"
        itemRadius={11}
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
            if ((convos[activeRepoPath ?? '']?.length ?? 0) > 0) redockActiveLane();
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
      </ProximityDock>

      <AnimatePresence>
        {filePathPickerOpen ? (
          <>
            <div role="presentation" onClick={() => setFilePathPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.form
              initial={{ opacity: 0, x: -10, scale: 0.98 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -10, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onSubmit={(event) => {
                event.preventDefault();
                openPathAsFileCard(filePathInput);
              }}
              style={{
                ...glassPop(),
                position: 'absolute',
                left: 64,
                top: '50%',
                marginTop: -26,
                width: 316,
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
                paddingTop: 12,
                paddingBottom: 12,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 14,
                zIndex: 46,
                fontFamily: FONT,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)' }}>
                  Open file
                </span>
                <button
                  type="button"
                  aria-label="Close file path picker"
                  onClick={() => setFilePathPickerOpen(false)}
                  style={{ width: 22, height: 22, borderWidth: 0, borderRadius: 8, background: 'transparent', color: 'var(--cnv-ink-muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; event.currentTarget.style.color = 'var(--cnv-ink)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
                >
                  <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 34, borderRadius: 10, border: '1px solid var(--cnv-edge)', background: 'var(--cnv-tint)', paddingLeft: 10, paddingRight: 8 }}>
                <input
                  autoFocus
                  value={filePathInput}
                  onChange={(event) => setFilePathInput(event.target.value)}
                  placeholder="/Users/you/project/file.ts"
                  aria-label="Absolute file path"
                  style={{ flex: 1, minWidth: 0, borderWidth: 0, outline: 'none', background: 'transparent', color: 'var(--cnv-ink)', fontSize: 12, fontWeight: 300, letterSpacing: '-0.1px', fontFamily: FONT }}
                />
                <button
                  type="submit"
                  disabled={filePickerBusy}
                  style={{ height: 24, paddingLeft: 10, paddingRight: 10, borderRadius: 8, border: '1px solid var(--cnv-edge)', background: 'var(--cnv-tint-deep)', color: 'var(--cnv-ink)', cursor: filePickerBusy ? 'default' : 'pointer', fontFamily: FONT, fontSize: 11, fontWeight: 300 }}
                >
                  Open
                </button>
              </div>
            </motion.form>
          </>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {canvasToast ? (
          <motion.div
            key={canvasToast.id}
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            role="status"
            style={{
              ...glassPop(),
              position: 'absolute',
              top: 18,
              left: 0,
              right: 0,
              width: 'fit-content',
              marginLeft: 'auto',
              marginRight: 'auto',
              zIndex: 60,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              maxWidth: 360,
              paddingTop: 9,
              paddingBottom: 9,
              paddingLeft: 12,
              paddingRight: 13,
              borderRadius: 14,
              fontFamily: FONT,
              fontSize: 11.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              border: `1px solid ${canvasToast.tone === 'error' ? 'var(--t-danger, #ef4444)' : canvasToast.tone === 'success' ? 'var(--t-success, #16a34a)' : 'var(--cnv-edge)'}`,
              color: canvasToast.tone === 'error' ? 'var(--t-danger, #ef4444)' : 'var(--cnv-ink)',
            }}
          >
            <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: canvasToast.tone === 'error' ? 'var(--t-danger, #ef4444)' : canvasToast.tone === 'success' ? 'var(--t-success, #16a34a)' : 'var(--cnv-ink-muted)' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{canvasToast.message}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* ── Navigator loupe (#1239) — minimap + −/fit/+ zoom + Free/Grid toggle,
            replacing the old zoom-level chip. Bottom-left. ───────────── */}
      <NavigatorLoupe
        cards={minimapCards}
        area={loupeArea}
        size={loupeSize}
        zoomSteps={ZOOM_STEPS}
        zoomValue={canvasZoomLevel}
        onZoomChange={setCanvasZoomLevel}
        gridMode={gridMode}
        onGridModeChange={setGridMode}
        onPanBy={(dx, dy) => setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }))}
        orbSettings={orbSettings}
        onOrbChange={updateOrbSettings}
        onOrbReset={resetOrbSettings}
        tone={settings.tone}
        panKey={Math.round(pan.x) + Math.round(pan.y)}
      />

      {/* ── Terminal cwd drawer — same system as the Sessions drawer:
            tuner-matched glass, hard edges, the list dissolves at both
            ends as you scroll. ───── */}
      <AnimatePresence>
        {termPickerOpen ? (
          <>
            <div role="presentation" onClick={() => setTermPickerOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
            <motion.div
              data-canvas-chrome
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
                {HOME_AGENTS.map((agent) => (
                  <PickerRow
                    key={agent.id}
                    name={`${agent.label} agent`}
                    path="local · ~"
                    onClick={() => {
                      // Home agent (#1244): an all-local agent CLI session in the
                      // home dir (no repo / worktree / governance) — auto-launches
                      // the chosen CLI on attach. Bypasses the mission pipeline.
                      spawnTerminal(null, `${agent.label} · ~`, undefined, { agentCli: agent.command });
                      setTermPickerOpen(false);
                    }}
                  />
                ))}
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
              data-canvas-chrome
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              style={{
                position: 'absolute',
                left: 80,
                top: '50%',
                height: RAIL_PANEL_HEIGHT,
                marginTop: -(RAIL_PANEL_HEIGHT / 2),
                width: 272,
                zIndex: 46,
                display: 'grid',
                // Pin the single row to the box height (minmax 0-floor stops it
                // growing to content) so a long list scrolls INSIDE the 296px
                // panel instead of overflowing it. Plain '1fr' wouldn't — its
                // auto min-floor lets the row grow.
                gridTemplateRows: 'minmax(0, 1fr)',
                fontFamily: FONT,
              }}
            >
              <SmoothCorners
                corners={{ radius: 22 }}
                shadowStrategy="box-shadow"
                style={{ ...LISSE_PANEL_SURFACE, paddingTop: 12, paddingBottom: 4, paddingLeft: 8, paddingRight: 8 }}
              >
              <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 7 }}>
                Review
              </span>
              {/* Pinned — YOUR uncommitted changes, not just agent lanes. */}
              <button
                type="button"
                onClick={() => {
                  void spawnWorktreeDiffCard();
                  setReviewPickerOpen(false);
                }}
                disabled={!activeRepoPath}
                style={{ display: 'flex', alignItems: 'center', gap: 7, paddingTop: 7, paddingBottom: 7, paddingLeft: 8, paddingRight: 8, borderRadius: 9, borderWidth: 0, background: 'transparent', cursor: activeRepoPath ? 'pointer' : 'default', fontFamily: FONT, textAlign: 'left', width: '100%', opacity: activeRepoPath ? 1 : 0.5 }}
                onMouseEnter={(event) => { if (activeRepoPath) event.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                <svg style={{ width: 11, height: 11, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M3 21h18" />
                </svg>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)', letterSpacing: '-0.1px' }}>
                    Your working tree
                  </span>
                  <span style={{ fontSize: 9.5, fontWeight: 260, color: 'var(--cnv-ink-muted)' }}>
                    {activeRepoName ? `uncommitted changes · ${activeRepoName}` : 'pick a repo first'}
                  </span>
                </span>
              </button>
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
                    No agents running yet — dispatch from the composer and lane diffs land here. (Your own changes are above.)
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
            </SmoothCorners>
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
              data-canvas-chrome
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              style={{
                position: 'absolute',
                left: 80,
                top: '50%',
                height: RAIL_PANEL_HEIGHT,
                marginTop: -(RAIL_PANEL_HEIGHT / 2),
                width: 272,
                zIndex: 46,
                display: 'grid',
                // Pin the single row to the box height (minmax 0-floor stops it
                // growing to content) so a long list scrolls INSIDE the 296px
                // panel instead of overflowing it. Plain '1fr' wouldn't — its
                // auto min-floor lets the row grow.
                gridTemplateRows: 'minmax(0, 1fr)',
                fontFamily: FONT,
              }}
            >
              <SmoothCorners
                corners={{ radius: 22 }}
                shadowStrategy="box-shadow"
                style={{ ...LISSE_PANEL_SURFACE, paddingTop: 12, paddingBottom: 4, paddingLeft: 8, paddingRight: 8 }}
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
                    redockActiveLane();
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
            </SmoothCorners>
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
            scouts={liveScouts[activeRepoPath ?? ''] ?? []}
            activeLabel={activeRepoName ?? '…'}
            activeTone={orcaBusy ? 'working' : 'idle'}
            onSelectLane={setActiveRepoPath}
            onSend={sendPrompt}
            busy={orcaBusy}
            queued={mainQueued}
            onCancelQueued={mainCancelQueued}
            undoArmed={mainUndoArmed}
            onUndoSend={mainStopOrUndo}
            onClose={undockToCard}
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
            onClick={redockActiveLane}
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

      {/* Mistake-proofing — queued follow-ups + the undo-send pill, floating
          just above the composer (clears of the picture pills when present). */}
      <div
        style={{
          position: 'absolute',
          bottom: composerImages.length ? 132 : 78,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 'min(680px, calc(100vw - 240px))',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          zIndex: 41,
          pointerEvents: dispatchLanes.length || mainQueued.length || mainUndoArmed ? 'auto' : 'none',
        }}
      >
        {/* Live agents working — grows out of the composer (gabriell_lab borrow).
            Sits ABOVE the queue so the two stack and never collide. */}
        <div data-canvas-chrome data-canvas-bottom-stack style={{ width: '100%' }}>
          <AnimatePresence>
            {dispatchLanes.length ? (
              <DispatchDock
                lanes={dispatchLanes}
                onSelect={(lane) => { if (lane.repoPath) setActiveRepoPath(lane.repoPath); setDockOpen(true); }}
                onReview={(lane) => { void spawnDiffCard(lane); }}
                onExpandedChange={setDockTrayExpanded}
              />
            ) : null}
          </AnimatePresence>
        </div>
        <div style={{ width: '100%' }}>
          <QueuedSends items={mainQueued} onCancel={mainCancelQueued} />
        </div>
        <AnimatePresence>
          {mainUndoArmed ? <UndoSendPill key="undo" onUndo={mainStopOrUndo} graceMs={SEND_UNDO_GRACE_MS} /> : null}
        </AnimatePresence>
      </div>

      {/* ── Bottom orchestrator input — first contact lives here ─── */}
      <div
        data-canvas-chrome
        data-canvas-bottom-stack
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
          minHeight: 48,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 10,
          paddingRight: 10,
          borderRadius: 24,
          zIndex: 40,
          ...glass(true),
        }}
      >
        <AnticipationRing focused={composerFocused} radius={24} />
        {/* Controls layer — fades out AND drops out of flow while an agent-lane
            (Right-Option) dictation morphs the composer into the live partials
            transcript, so the transcript fill alone drives the pill's height. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: 1,
            minWidth: 0,
            ...(partialsMorph.active
              ? { position: 'absolute', top: 8, bottom: 8, left: 10, right: 10 }
              : null),
            opacity: partialsMorph.active && !partialsMorph.closing ? 0 : 1,
            pointerEvents: partialsMorph.active && !partialsMorph.closing ? 'none' : 'auto',
            transition: reduceMotion ? undefined : 'opacity 120ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
        {/* Mode — fleet (dispatch) / single (solo) / fusion. The glyph IS the
            chip (the operator asked for "a fleet icon"); the popover carries the
            labels. Orange marks the live mode, matching the default composer. */}
        <button
          type="button"
          aria-label="Orchestration mode"
          aria-haspopup="menu"
          aria-expanded={composerMenu === 'mode'}
          title={`Mode: ${CANVAS_MODES.find((option) => option.id === orchMode)?.title ?? 'Fleet orchestration'}`}
          onClick={() => setComposerMenu((value) => (value === 'mode' ? null : 'mode'))}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            height: 24,
            paddingLeft: 8,
            paddingRight: 6,
            borderRadius: 999,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--cnv-edge)',
            background: composerMenu === 'mode' ? 'var(--cnv-tint)' : 'transparent',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--cnv-tint)'; }}
          onMouseLeave={(event) => { if (composerMenu !== 'mode') event.currentTarget.style.background = 'transparent'; }}
        >
          <span aria-hidden style={{ display: 'inline-flex', color: 'var(--t-brand-orange, #FF5A1F)' }}>
            <ModeGlyph mode={orchMode} size={12} />
          </span>
          <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink-muted)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ opacity: 0.7 }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <ChipButton
          label={activeRepoName ?? '…'}
          active={composerMenu === 'repo'}
          onClick={() => setComposerMenu((value) => (value === 'repo' ? null : 'repo'))}
        />
        <textarea
          ref={composerInputRef}
          value={composerValue}
          onChange={(event) => setComposerValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter drops a newline (the field grows to fit).
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
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
          onFocus={() => { setComposerFocused(true); registerComposerDictation(); }}
          onBlur={() => setComposerFocused(false)}
          rows={1}
          style={{
            flex: 1,
            minWidth: 0,
            borderWidth: 0,
            outline: 'none',
            background: 'transparent',
            color: 'var(--cnv-ink)',
            fontSize: 13,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            fontFamily: FONT,
            // Grow with the content instead of nested scrolling (design-eng
            // tip). field-sizing is supported in the app's WebKit — verified
            // live; it caps at maxHeight, then scrolls.
            fieldSizing: 'content',
            resize: 'none',
            maxHeight: 160,
            overflowY: 'auto',
            lineHeight: 1.4,
            paddingTop: 0,
            paddingBottom: 0,
          } as React.CSSProperties}
        />
        {/* One model chip — its drawer sets BOTH model + thinking. The current
            thinking effort rides as a muted suffix so it stays at-a-glance. */}
        <ChipButton
          label={CANVAS_MODEL_OPTIONS.find((option) => option.value === orcaModel)?.label ?? orcaModel}
          sub={orcaEffort}
          active={composerMenu === 'model'}
          onClick={() => setComposerMenu((value) => (value === 'model' ? null : 'model'))}
        />
        {/* Push-to-talk — speak the prompt. Canvas-tinted to sit flush with the
            send arrow; hides itself when no dictation host is mounted. */}
        <MicButton idleColor="var(--cnv-ink-muted)" />
        <button
          type="button"
          aria-label={orcaBusy ? (mainUndoArmed ? 'Stop and undo the send' : 'Interrupt the orchestrator') : 'Send'}
          onClick={() => {
            if (orcaBusy) mainStopOrUndo();
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
        {/* Live agent partials — the Right-Option dictation streams here in place
            of the controls, the pill growing upward like the outside HUD. */}
        {partialsMorph.active ? (
          <ComposerPartialsFill
            phase={partialsMorph.phase}
            text={partialsMorph.text}
            closing={partialsMorph.closing}
            reduce={reduceMotion}
          />
        ) : null}
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
              {composerMenu === 'repo' ? (
                <>
                  <DrawerLabel>Orchestrator repo</DrawerLabel>
                  {(() => {
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
                  })()}
                </>
              ) : composerMenu === 'mode' ? (
                <>
                  <DrawerLabel>Mode</DrawerLabel>
                  {CANVAS_MODES.map((option) => (
                    <ModeRow
                      key={option.id}
                      mode={option.id}
                      title={option.title}
                      detail={option.detail}
                      active={option.id === orchMode}
                      onClick={() => chooseMode(option.id)}
                    />
                  ))}
                </>
              ) : (
                <>
                  {/* Merged Model + Thinking drawer (operator call 2026-06-14):
                      one chip, two sections, checkmark on the live choice, set
                      both before dismissing. */}
                  <DrawerLabel>Model</DrawerLabel>
                  {CANVAS_MODEL_OPTIONS.map((option) => (
                    <PickerRow key={option.value} name={option.label} active={option.value === orcaModel} onClick={() => chooseModel(option.value)} />
                  ))}
                  <div style={{ height: 1, background: 'var(--cnv-edge)', opacity: 0.6, marginTop: 7, marginBottom: 5, marginLeft: 8, marginRight: 8 }} />
                  <DrawerLabel>Thinking</DrawerLabel>
                  {THINKING_EFFORTS.map((effort) => (
                    <PickerRow key={effort} name={effort} active={effort === orcaEffort} onClick={() => chooseEffort(effort)} />
                  ))}
                </>
              )}
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
            full={foundersGlass !== false}
            personalDefault={personalDefault}
            loupeSize={loupeSize}
            loupeSizeRange={LOUPE_SIZE_RANGE}
            onLoupeSizeChange={setLoupeSize}
            onSaveDefault={() => {
              savePersonalDefault(settings);
              setPersonalDefault({ ...settings });
            }}
          />
        ) : null}
      </AnimatePresence>

      {/* First-run welcome — frosts the canvas behind a hero card. Rendered at
          chrome level (outside the zoom layer) so it sits at device 1:1. */}
      <WelcomeModal open={welcomeOpen} onClose={closeWelcome} onStart={startFromWelcome} tone={settings.tone} />
      <ShareBetaModal open={shareBetaOpen} onClose={() => setShareBetaOpen(false)} tone={settings.tone} />
      <CanvasTour open={tourOpen} onClose={closeTour} onComplete={() => setShareBetaOpen(true)} />
    </SmoothCorners>
  );
}

/** Section label inside the composer drawer (uppercase, muted). */
function DrawerLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)', fontFamily: FONT, paddingLeft: 8, paddingBottom: 5 }}>
      {children}
    </span>
  );
}

function PickerRow({ name, path, active, onClick }: { name: string; path?: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
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
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 11.5, fontWeight: active ? 500 : 400, letterSpacing: '-0.1px', color: 'var(--cnv-ink)' }}>{name}</span>
        {path ? (
          <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{path}</span>
        ) : null}
      </span>
      {active ? (
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="var(--cnv-ink)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : null}
    </button>
  );
}

/** Small pill control in the composer — repo scope + model (with a muted
 *  thinking-effort suffix via `sub`). */
function ChipButton({ label, sub, active, onClick }: { label: string; sub?: string; active: boolean; onClick: () => void }) {
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
      {sub ? <span style={{ marginLeft: 5, fontWeight: 300, opacity: 0.55 }}>{sub}</span> : null}
    </button>
  );
}

/** Glyph for an orchestration mode — fleet fan-out, single node, fusion
 *  sparkle. Shared by the composer's mode trigger and the MODE popover rows so
 *  the chip always shows the live mode's mark. */
function ModeGlyph({ mode, size = 13 }: { mode: CanvasMode; size?: number }) {
  if (mode === 'single') {
    // One node inside a ring — the visual opposite of fleet's three-node fan-out.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
        <circle cx="12" cy="12" r="3" />
        <circle cx="12" cy="12" r="8" />
      </svg>
    );
  }
  if (mode === 'fusion') {
    // Sparkle — reads as the "deeper / more" pass beside the fleet fan-out.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
      </svg>
    );
  }
  // fleet — three nodes fanning out (matches the default composer's FleetGlyph).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 8v4" />
      <path d="m12 12-6 4" />
      <path d="m12 12 6 4" />
    </svg>
  );
}

/** One row in the composer's MODE popover — glyph + title + detail, orange
 *  check on the live mode. Canvas-token twin of the default composer's
 *  PopoverRow (richer than PickerRow, which is title-only). */
function ModeRow({ mode, title, detail, active, onClick }: { mode: CanvasMode; title: string; detail: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="menuitem"
      style={{
        display: 'grid',
        gridTemplateColumns: '18px minmax(0, 1fr) 14px',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        borderWidth: 0,
        background: active ? 'var(--cnv-tint)' : 'transparent',
        borderRadius: 9,
        paddingTop: 7,
        paddingBottom: 7,
        paddingLeft: 8,
        paddingRight: 8,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: FONT,
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--cnv-tint)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
    >
      <span aria-hidden style={{ display: 'inline-flex', color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--cnv-ink-muted)' }}>
        <ModeGlyph mode={mode} size={13} />
      </span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 400, color: 'var(--cnv-ink)', letterSpacing: '-0.1px', lineHeight: 1.25 }}>{title}</span>
        <span style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--cnv-ink-muted)', letterSpacing: '-0.05px', lineHeight: 1.3 }}>{detail}</span>
      </span>
      <span aria-hidden style={{ display: 'inline-flex', opacity: active ? 1 : 0, color: 'var(--t-brand-orange, #FF5A1F)' }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 4 4 10-10" />
        </svg>
      </span>
    </button>
  );
}
