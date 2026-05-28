'use client';

/**
 * ContextualPanel — global operator terminal in the bottom panel.
 *
 * This surface stays unscoped on purpose:
 * - scratch shell work
 * - quick command execution
 * - general operator utilities
 *
 * Repo-owned inspectors and task surfaces belong in repo-scoped workspace panes.
 */

import { Suspense, forwardRef, lazy, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useTheme } from '@/lib/theme/context';
import { buildXtermTheme } from '@/components/desktop/workspace-terminal/constants';
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '@/components/desktop/repo-registry/shared';
import { useExperimentalOpencodeFlag } from '@/lib/operator/use-experimental-opencode';
import { O8BrowserPane } from '@/components/desktop/O8BrowserPane';
import { AllFilesTree } from '@/components/desktop/o8-panel/workspace-rail/AllFilesTree';
import { FileViewer } from '@/components/desktop/o8-panel/workspace-rail/FileViewer';
import { ReviewPanel } from '@/components/desktop/review/ReviewPanel';
import type { DetectedLocalhostPreview } from '@/lib/panel/preview';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const LazyOrchestratorTab = lazy(() => import('@/components/desktop/workspace-terminal/OrchestratorTab').then((module) => ({ default: module.OrchestratorTab })));

// ── CLI Agents (terminal only, no chat modes) ──

const CLI_AGENTS = [
  { id: 'shell', label: 'Shell', color: '#64748b', command: null },
  { id: 'claude', label: 'Claude Code', color: '#e07a3a', command: 'claude' },
  { id: 'codex', label: 'Codex', color: '#6b7280', command: 'codex' },
  { id: 'opencode', label: 'OpenCode', color: '#fb923c', command: 'opencode' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4285f4', command: 'gemini' },
] as const;

type CliAgent = (typeof CLI_AGENTS)[number];

function AgentGlyph({ agentId, size = 14 }: { agentId: string; size?: number }) {
  if (agentId === 'claude') return <ClaudeIcon size={size} />;
  if (agentId === 'codex') return <CodexIcon size={size} />;
  if (agentId === 'opencode') return <OpenCodeIcon size={size} />;
  if (agentId === 'gemini') return <GeminiIcon size={size} />;
  // shell fallback — a small square/terminal glyph via AgentDot below
  return null;
}

// ── Types ──

export interface ContextualPanelHandle {
  onSessionCreated: (sessionName: string, requestId?: string) => boolean;
  writeToTerminal: (sessionName: string, data: string) => void;
  showImage: (sessionName: string, imageB64: string, filename: string) => void;
  setTermError: (sessionName: string, error: string) => void;
  setTermExited: (sessionName: string) => void;
  /** Returns the current tmux session name, or null if not connected */
  getSession: () => string | null;
  /** Ensure a terminal exists, then run the command inside it. */
  runCommand: (command: string) => void;
  /** Open or focus one of the bottom panel's non-terminal utility surfaces. */
  openSurface: (surface: BottomPanelSurfaceKind) => void;
}

export type BottomPanelSurfaceKind = 'files' | 'side-chat' | 'browser' | 'review' | 'terminal';

export interface ContextualPanelProps {
  sendTerminalCreate: (cols: number, rows: number, requestId?: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  sendAgentKill: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
  termWsConnected: boolean;
  repoPath?: string | null;
  repoLabel?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  previews?: DetectedLocalhostPreview[];
  onRepoPathChange?: (repoPath: string) => void;
  onSplitVertical?: () => void;
  panelLabel?: string;
  onClose: () => void;
}

// ── Helpers ──

function AgentDot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
    }} />
  );
}

// Lucide icons as raw SVG (Tauri webview compatibility)
function TerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </svg>
  );
}

function FilesIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
      <path d="M2 10h20" />
    </svg>
  );
}

function ChatIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </svg>
  );
}

function BrowserIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 0 20" />
      <path d="M12 2a15.3 15.3 0 0 0 0 20" />
    </svg>
  );
}

function ReviewIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="m9 15 2 2 4-5" />
    </svg>
  );
}

function XIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function SplitVerticalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 4v16" />
      <path d="M6 7v10" />
      <path d="M18 7v10" />
    </svg>
  );
}

// ── Inline XtermPanel (mirrors TerminalWorkspace pattern) ──

interface InlineImage {
  id: string;
  dataUrl: string;
  filename: string;
}

interface XtermPanelHandle {
  writeData: (data: string) => void;
  showImage: (imageB64: string, filename: string) => void;
  setError: (error: string) => void;
  setExited: () => void;
}

const BottomXtermPanel = forwardRef<XtermPanelHandle, {
  tmuxSession: string;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  visible: boolean;
}>(function BottomXtermPanel(
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
        term.onData((data) => { sendTerminalInput(tmuxSession, data); });

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

    return () => {
      disposed = true;
      sendTerminalDetach(tmuxSession);
      cleanupPromise?.then(cleanup => cleanup?.());
      if (termRef.current) { termRef.current.dispose(); termRef.current = null; }
      fitAddonRef.current = null;
    };
  }, [tmuxSession, sendTerminalAttach, sendTerminalInput, sendTerminalResize, sendTerminalDetach]);

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
        flex: 1, width: '100%', background: 'var(--t-terminal-bg, #16191e)', paddingTop: 2, paddingLeft: 2,
      }} />
    </div>
  );
});

// ── Main Component ──

interface BottomPanelSurface {
  id: BottomPanelSurfaceKind;
  label: string;
  description: string;
  icon: (props: { size?: number }) => React.ReactNode;
}

const BOTTOM_PANEL_SURFACES: BottomPanelSurface[] = [
  { id: 'files', label: 'Files', description: 'Browse project files', icon: FilesIcon },
  { id: 'side-chat', label: 'Side chat', description: 'Start a side conversation', icon: ChatIcon },
  { id: 'browser', label: 'Browser', description: 'Open a website', icon: BrowserIcon },
  { id: 'review', label: 'Review', description: 'View code changes', icon: ReviewIcon },
  { id: 'terminal', label: 'Terminal', description: 'Start an interactive shell', icon: TerminalIcon },
];

const SURFACE_LABELS = Object.fromEntries(
  BOTTOM_PANEL_SURFACES.map((surface) => [surface.id, surface.label]),
) as Record<BottomPanelSurfaceKind, string>;

interface ContextualPanelTab {
  id: string;
  label: string;
  kind: BottomPanelSurfaceKind;
  agentId?: CliAgent['id'];
  tmuxSession: string | null;
  createdAt: number;
  lastActivity: number;
}

function SurfaceEmptyState({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div style={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      color: 'var(--t-text-muted)',
      background: 'var(--t-bg)',
      textAlign: 'center',
      padding: 24,
    }}>
      <div style={{
        width: 42,
        height: 42,
        borderRadius: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--t-text-secondary)',
        background: 'var(--t-input-bg)',
        border: '1px solid var(--t-divider-subtle)',
      }}>
        {icon}
      </div>
      <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--t-text)' }}>{title}</div>
      <div style={{ maxWidth: 360, fontSize: 12, lineHeight: 1.5 }}>{detail}</div>
    </div>
  );
}

function BottomUtilitySurface({
  kind,
  tabId,
  active,
  repoPath,
  repoLabel,
  registeredRepos,
  previews,
  selectedFile,
  dirtyFiles,
  onSelectFile,
  onRepoPathChange,
  onOpenFilesSurface,
}: {
  kind: Exclude<BottomPanelSurfaceKind, 'terminal'>;
  tabId: string;
  active: boolean;
  repoPath: string | null;
  repoLabel: string | null;
  registeredRepos: RepoRegistryEntry[];
  previews: DetectedLocalhostPreview[];
  selectedFile: string | null;
  dirtyFiles: Set<string>;
  onSelectFile: (path: string) => void;
  onRepoPathChange?: (repoPath: string) => void;
  onOpenFilesSurface: () => void;
}) {
  if (kind === 'files') {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(210px, 30%) minmax(0, 1fr)', background: 'var(--t-bg)' }}>
        <div style={{ minWidth: 0, minHeight: 0, display: 'flex', borderRight: '1px solid var(--t-divider-subtle)', background: 'var(--t-panel)' }}>
          <AllFilesTree
            repoPath={repoPath}
            selectedFile={selectedFile}
            dirtyFiles={dirtyFiles}
            onSelectFile={onSelectFile}
          />
        </div>
        <FileViewer repoPath={repoPath} selectedFile={selectedFile} />
      </div>
    );
  }

  if (kind === 'side-chat') {
    return (
      <Suspense fallback={<SurfaceEmptyState icon={<ChatIcon size={18} />} title="Loading side chat" detail="Preparing a repo-aware conversation in the bottom panel." />}>
        <LazyOrchestratorTab
          tabId={tabId}
          active={active}
          repoPath={repoPath}
          repoLabel={repoLabel}
          initialMode="fleet"
          acceptHistoryThreadLoads={false}
          restoreLastThread={false}
          publishWorkspaceThread={false}
          persistLastThread={false}
          projectContextRailVisible={false}
        />
      </Suspense>
    );
  }

  if (kind === 'browser') {
    return (
      <O8BrowserPane
        previews={previews}
        onOpenFile={(filePath) => {
          onSelectFile(filePath);
          onOpenFilesSurface();
        }}
      />
    );
  }

  if (kind === 'review') {
    if (!repoPath) {
      return (
        <SurfaceEmptyState
          icon={<ReviewIcon size={18} />}
          title="No repository selected"
          detail="Select or register a repo before opening review in the bottom panel."
        />
      );
    }
    return (
      <ReviewPanel
        repoPath={repoPath}
        registeredRepos={registeredRepos}
        onRepoPathChange={onRepoPathChange}
        selectedFile={selectedFile}
      />
    );
  }

  return (
    <SurfaceEmptyState
      icon={<FilesIcon size={18} />}
      title={repoLabel ?? 'Bottom panel'}
      detail="Choose a bottom panel surface from the plus menu."
    />
  );
}

export const ContextualPanel = forwardRef<ContextualPanelHandle, ContextualPanelProps>(
  function ContextualPanel(
    {
      sendTerminalCreate,
      sendTerminalAttach,
      sendTerminalInput,
      sendTerminalResize,
      sendTerminalDetach,
      termWsConnected,
      repoPath = null,
      repoLabel = null,
      registeredRepos = [],
      previews = [],
      onRepoPathChange,
      onSplitVertical,
      panelLabel = 'Bottom Panel',
      onClose,
    },
    ref,
  ) {
    const [tabs, setTabs] = useState<ContextualPanelTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string>('');
    const [addMenuOpen, setAddMenuOpen] = useState(false);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const opencodeEnabled = useExperimentalOpencodeFlag();
    const visibleAgents = opencodeEnabled ? CLI_AGENTS : CLI_AGENTS.filter((a) => a.id !== 'opencode');
    const pendingTabIdsRef = useRef<string[]>([]);
    const pendingAgentsRef = useRef<Map<string, CliAgent['id']>>(new Map());
    const pendingRequestRef = useRef<Map<string, string>>(new Map());
    const pendingCommandsRef = useRef<Map<string, string>>(new Map());
    const tabCountRef = useRef(0);
    const tabsRef = useRef<ContextualPanelTab[]>([]);
    const xtermRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
    const addMenuRef = useRef<HTMLDivElement>(null);
    const dirtyFiles = useMemo(() => new Set<string>(), []);
    const panelLabelLower = panelLabel.toLowerCase();

    useEffect(() => { tabsRef.current = tabs; }, [tabs]);

    const createBottomTab = useCallback((agent: CliAgent, initialCommand?: string) => {
      tabCountRef.current += 1;
      const now = Date.now();
      const nextTab: ContextualPanelTab = {
        id: `bottom-tab-${tabCountRef.current}`,
        label: agent.label,
        kind: 'terminal',
        agentId: agent.id,
        tmuxSession: null,
        createdAt: now,
        lastActivity: now,
      };
      const requestId = `bottom-${nextTab.id}-${now}`;
      pendingAgentsRef.current.set(nextTab.id, agent.id);
      pendingTabIdsRef.current.push(nextTab.id);
      pendingRequestRef.current.set(requestId, nextTab.id);
      const commandParts = [agent.command, initialCommand].filter(Boolean);
      if (commandParts.length > 0) {
        pendingCommandsRef.current.set(nextTab.id, commandParts.join(' && '));
      }
      setTabs((prev) => [...prev, nextTab]);
      setActiveTabId(nextTab.id);
      sendTerminalCreate(120, 30, requestId);
    }, [sendTerminalCreate]);

    const createSurfaceTab = useCallback((surface: Exclude<BottomPanelSurfaceKind, 'terminal'>) => {
      const existing = tabsRef.current.find((tab) => tab.kind === surface);
      if (existing) {
        setActiveTabId(existing.id);
        return existing.id;
      }

      tabCountRef.current += 1;
      const now = Date.now();
      const nextTab: ContextualPanelTab = {
        id: `bottom-${surface}-${tabCountRef.current}`,
        label: SURFACE_LABELS[surface],
        kind: surface,
        tmuxSession: null,
        createdAt: now,
        lastActivity: now,
      };
      setTabs((prev) => [...prev, nextTab]);
      setActiveTabId(nextTab.id);
      return nextTab.id;
    }, []);

    const openSurface = useCallback((surface: BottomPanelSurfaceKind) => {
      setAddMenuOpen(false);
      if (surface === 'terminal') {
        const existingTerminal = tabsRef.current.find((tab) => tab.kind === 'terminal' && tab.tmuxSession);
        if (existingTerminal) {
          setActiveTabId(existingTerminal.id);
          return existingTerminal.id;
        }
        createBottomTab(CLI_AGENTS[0]);
        return null;
      }
      return createSurfaceTab(surface);
    }, [createBottomTab, createSurfaceTab]);

    // Close add menu on outside click
    useEffect(() => {
      if (!addMenuOpen) return;
      const handler = (e: MouseEvent) => {
        if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
          setAddMenuOpen(false);
        }
      };
      const timer = setTimeout(() => document.addEventListener('mousedown', handler), 100);
      return () => { clearTimeout(timer); document.removeEventListener('mousedown', handler); };
    }, [addMenuOpen]);

    // Create default shell tab on mount / reconnect
    useEffect(() => {
      if (!termWsConnected || tabsRef.current.length > 0 || pendingTabIdsRef.current.length > 0) return;
      createBottomTab(CLI_AGENTS[0]);
    }, [createBottomTab, termWsConnected]);

    // Imperative handle for dashboard event routing
    useImperativeHandle(ref, () => ({
      onSessionCreated: (sessionName: string, requestId?: string) => {
        const matchedTabId = requestId ? pendingRequestRef.current.get(requestId) : undefined;
        const nextTabId = matchedTabId ?? pendingTabIdsRef.current.shift();
        if (!nextTabId) return false;
        if (requestId) {
          pendingRequestRef.current.delete(requestId);
          pendingTabIdsRef.current = pendingTabIdsRef.current.filter((entry) => entry !== nextTabId);
        }
        pendingAgentsRef.current.delete(nextTabId);

        setTabs((prev) => prev.map((entry) => (
          entry.id === nextTabId
            ? { ...entry, tmuxSession: sessionName, lastActivity: Date.now() }
            : entry
        )));

        const pendingCommand = pendingCommandsRef.current.get(nextTabId);
        pendingCommandsRef.current.delete(nextTabId);

        if (pendingCommand) {
          fetch('/api/panel/terminal-exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionName, command: pendingCommand }),
          }).catch(() => {
            // Fallback: send via WS input
            setTimeout(() => sendTerminalInput(sessionName, pendingCommand + '\n'), 2000);
          });
        }
        return true;
      },
      writeToTerminal: (sessionName: string, data: string) => {
        xtermRefs.current.get(sessionName)?.writeData(data);
        setTabs((prev) => prev.map((entry) => (
          entry.tmuxSession === sessionName
            ? { ...entry, lastActivity: Date.now() }
            : entry
        )));
      },
      showImage: (sessionName: string, imageB64: string, filename: string) => {
        xtermRefs.current.get(sessionName)?.showImage(imageB64, filename);
      },
      setTermError: (sessionName: string, error: string) => {
        xtermRefs.current.get(sessionName)?.setError(error);
      },
      setTermExited: (sessionName: string) => {
        xtermRefs.current.get(sessionName)?.setExited();
      },
      getSession: () => tabsRef.current.find((entry) => entry.id === activeTabId && entry.kind === 'terminal')?.tmuxSession ?? null,
      runCommand: (command: string) => {
        const activeTab = tabsRef.current.find((entry) => entry.id === activeTabId && entry.kind === 'terminal');
        if (activeTab?.tmuxSession) {
          sendTerminalInput(activeTab.tmuxSession, command + '\n');
          return;
        }

        const existingShell = tabsRef.current.find((entry) => entry.kind === 'terminal' && entry.agentId === 'shell' && entry.tmuxSession);
        if (existingShell?.tmuxSession) {
          setActiveTabId(existingShell.id);
          sendTerminalInput(existingShell.tmuxSession, command + '\n');
          return;
        }

        const pendingShell = tabsRef.current.find((entry) => entry.kind === 'terminal' && entry.agentId === 'shell' && !entry.tmuxSession);
        if (pendingShell) {
          pendingCommandsRef.current.set(pendingShell.id, command);
          setActiveTabId(pendingShell.id);
          return;
        }

        createBottomTab(CLI_AGENTS[0], command);
      },
      openSurface,
    }), [activeTabId, createBottomTab, openSurface, sendTerminalInput]);

    const handleCreateTab = useCallback((agent: CliAgent) => {
      setAddMenuOpen(false);
      createBottomTab(agent);
    }, [createBottomTab]);

    const handleCreateSurface = useCallback((surface: BottomPanelSurfaceKind) => {
      openSurface(surface);
    }, [openSurface]);

    const handleCloseTab = useCallback((tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return;

      if (tab.kind === 'terminal' && tab.tmuxSession) {
        sendTerminalDetach(tab.tmuxSession);
        xtermRefs.current.delete(tab.tmuxSession);
      } else if (tab.kind === 'terminal') {
        pendingTabIdsRef.current = pendingTabIdsRef.current.filter((entry) => entry !== tabId);
        pendingAgentsRef.current.delete(tabId);
        pendingCommandsRef.current.delete(tabId);
        for (const [requestId, pendingTabId] of pendingRequestRef.current) {
          if (pendingTabId === tabId) pendingRequestRef.current.delete(requestId);
        }
      }

      const remaining = tabsRef.current.filter((entry) => entry.id !== tabId);
      setTabs(remaining);

      if (remaining.length === 0) {
        setActiveTabId('');
        if (termWsConnected) {
          createBottomTab(CLI_AGENTS[0]);
        }
        return;
      }

      if (activeTabId === tabId) {
        const idx = tabsRef.current.findIndex((entry) => entry.id === tabId);
        const nextIdx = Math.min(idx, remaining.length - 1);
        setActiveTabId(remaining[nextIdx].id);
      }
    }, [activeTabId, createBottomTab, sendTerminalDetach, termWsConnected]);

    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--t-bg)',
      }}>
        {/* Header bar — single-line bottom panel chrome */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 36,
          flexShrink: 0,
          background: 'var(--t-chrome, var(--t-panel))',
          borderBottom: '1px solid var(--t-divider)',
          paddingLeft: 8,
          paddingRight: 8,
          position: 'relative',
          zIndex: 30,
          color: 'var(--t-text-secondary)',
        } as React.CSSProperties}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
            minWidth: 0,
            paddingRight: 10,
            borderRight: '1px solid var(--t-divider)',
          }}>
            <TerminalIcon size={13} />
            <span style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: 'var(--t-text)',
              whiteSpace: 'nowrap',
            }}>
              {panelLabel}
            </span>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flex: 1,
            minWidth: 0,
            overflowX: 'auto',
            overflowY: 'hidden',
          }}>
            {tabs.map((tab) => {
              const agent = tab.kind === 'terminal'
                ? CLI_AGENTS.find((entry) => entry.id === tab.agentId) ?? CLI_AGENTS[0]
                : null;
              const SurfaceIcon = tab.kind === 'terminal'
                ? null
                : BOTTOM_PANEL_SURFACES.find((entry) => entry.id === tab.kind)?.icon ?? FilesIcon;
              const isActive = tab.id === activeTabId;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setActiveTabId(tab.id);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    height: 28,
                    paddingTop: 0,
                    paddingRight: 10,
                    paddingBottom: 0,
                    paddingLeft: 10,
                    borderRadius: 8,
                    border: 'none',
                    background: isActive ? 'var(--t-panel-hover)' : 'transparent',
                    boxShadow: 'none',
                    color: isActive ? 'var(--t-text)' : 'var(--t-text-muted)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {agent
                    ? (agent.id === 'shell'
                        ? <AgentDot color={agent.color} />
                        : <AgentGlyph agentId={agent.id} size={12} />)
                    : SurfaceIcon?.({ size: 12 })}
                  <span style={{
                    fontSize: 12,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                    whiteSpace: 'nowrap',
                  }}>
                    {tab.label}
                  </span>
                  {tabs.length > 1 && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCloseTab(tab.id);
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        color: 'var(--t-text-faint)',
                      }}
                    >
                      <XIcon size={10} />
                    </span>
                  )}
                </button>
              );
            })}

          </div>

          <div ref={addMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setAddMenuOpen((prev) => !prev)}
              aria-label={`Add ${panelLabelLower} tab`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 8,
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <PlusIcon size={14} />
            </button>

            {addMenuOpen && (
              <div style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                right: 0,
                width: 420,
                borderRadius: 14,
                background: 'var(--t-panel)',
                backdropFilter: 'blur(24px) saturate(1.6)',
                WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
                border: '1px solid var(--t-divider)',
                boxShadow: '0 12px 40px rgba(15, 23, 42, 0.15), 0 2px 6px rgba(15, 23, 42, 0.06)',
                paddingTop: 4,
                paddingRight: 4,
                paddingBottom: 4,
                paddingLeft: 4,
                zIndex: 400,
              } as React.CSSProperties}>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 4,
                  paddingBottom: 6,
                  borderBottom: '1px solid var(--t-divider-subtle)',
                  marginBottom: 4,
                }}>
                  {BOTTOM_PANEL_SURFACES.map((surface) => {
                    const SurfaceIcon = surface.icon;
                    return (
                      <button
                        key={surface.id}
                        type="button"
                        onClick={() => handleCreateSurface(surface.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          minHeight: 58,
                          paddingTop: 9,
                          paddingRight: 10,
                          paddingBottom: 9,
                          paddingLeft: 10,
                          borderRadius: 10,
                          border: '1px solid transparent',
                          background: 'transparent',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--t-hover)';
                          e.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.borderColor = 'transparent';
                        }}
                      >
                        <span style={{
                          width: 28,
                          height: 28,
                          borderRadius: 9,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--t-text-secondary)',
                          background: 'var(--t-input-bg)',
                          flexShrink: 0,
                        }}>
                          {SurfaceIcon({ size: 15 })}
                        </span>
                        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          <span style={{ fontSize: 12.5, lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
                            {surface.label}
                          </span>
                          <span style={{ fontSize: 9.5, lineHeight: 1.25, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {surface.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {visibleAgents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => handleCreateTab(agent)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      width: '100%',
                      paddingTop: 7,
                      paddingRight: 10,
                      paddingBottom: 7,
                      paddingLeft: 10,
                      borderRadius: 10,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{
                      width: 18,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      {agent.id === 'shell'
                        ? <AgentDot color={agent.color} />
                        : <AgentGlyph agentId={agent.id} size={16} />}
                    </span>
                    <span style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'var(--t-text)',
                      flex: 1,
                    }}>
                      {agent.label}
                    </span>
                    {agent.command && (
                      <span style={{
                        fontSize: 10,
                        fontFamily: 'ui-monospace, "SF Mono", monospace',
                        color: 'var(--t-text-faint)',
                      }}>
                        $ {agent.command}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Split-vertical button removed 2026-05-27 — bottom panel
              leans on tabs for multiple surfaces. */}

          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${panelLabelLower}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 8,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
              transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <XIcon size={14} />
          </button>
        </div>

        {/* Panel body */}
        {tabs.length > 0 ? (
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {tabs.map((tab) => (
              tab.kind === 'terminal' && tab.tmuxSession ? (
                <BottomXtermPanel
                  key={tab.tmuxSession}
                  ref={(handle) => {
                    if (handle) xtermRefs.current.set(tab.tmuxSession!, handle);
                    else xtermRefs.current.delete(tab.tmuxSession!);
                  }}
                  tmuxSession={tab.tmuxSession}
                  sendTerminalAttach={sendTerminalAttach}
                  sendTerminalInput={sendTerminalInput}
                  sendTerminalResize={sendTerminalResize}
                  sendTerminalDetach={sendTerminalDetach}
                  visible={tab.id === activeTabId}
                />
              ) : tab.kind === 'terminal' ? (
                <div
                  key={tab.id}
                  style={{
                    flex: 1,
                    display: tab.id === activeTabId ? 'flex' : 'none',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    color: 'var(--t-text-faint)',
                    fontSize: 14,
                    height: '100%',
                  }}
                >
                  <TerminalIcon size={18} />
                  Connecting...
                </div>
              ) : (
                <div
                  key={tab.id}
                  aria-hidden={tab.id !== activeTabId}
                  style={{
                    display: tab.id === activeTabId ? 'flex' : 'none',
                    flex: 1,
                    minHeight: 0,
                    height: '100%',
                    background: 'var(--t-bg)',
                    overflow: 'hidden',
                  }}
                >
                  <BottomUtilitySurface
                    kind={tab.kind}
                    tabId={tab.id}
                    active={tab.id === activeTabId}
                    repoPath={repoPath}
                    repoLabel={repoLabel}
                    registeredRepos={registeredRepos}
                    previews={previews}
                    selectedFile={selectedFile}
                    dirtyFiles={dirtyFiles}
                    onSelectFile={setSelectedFile}
                    onRepoPathChange={onRepoPathChange}
                    onOpenFilesSurface={() => createSurfaceTab('files')}
                  />
                </div>
              )
            ))}
          </div>
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: 'var(--t-text-faint)',
            fontSize: 14,
          }}>
            <TerminalIcon size={18} />
            Connecting...
          </div>
        )}
      </div>
    );
  },
);
