import type { CanvasRepoTaskLaunchRequest, CanvasTab } from '@/components/desktop/Canvas';
import type { LLMMessage } from '@/components/desktop/LLMChat';
import type { LinkedIssueRef } from '@/components/desktop/IssueLinkPicker';
import type { ChatModelId } from '@/components/desktop/orchestrator/chat-models';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';
import type { RepoReadiness } from '@/lib/repos/types';
import type { PersistedChatCheckpoint } from '@/lib/terminal/tab-state';
import type {
  OrchestrationMode,
  OrchestratorLaneSnapshot,
  OrchestratorRuntime,
  WorkspaceLaneState,
  WorkspaceOrchestrationPacketBadge,
} from '@/lib/orchestrator/types';
import type {
  DetectedLocalhostPreview,
  PreviewSelectionPayload,
} from '@/lib/panel/preview';

export interface RegisteredRepo {
  name: string;
  localPath: string;
  remoteUrl?: string;
  branch?: string | null;
  readiness?: RepoReadiness | null;
  registryRepoId?: string;
  isWorktree?: boolean;
  worktreeStatus?: string | null;
}

export interface TerminalTab {
  id: string;
  label: string;
  /**
   * NAMING GOTCHA — read carefully:
   *   - 'orchestrator'  → Fleet/Claude orchestrator tab (planning + dispatch)
   *   - 'llm-chat'      → casual o8 Chat tab (the user-facing "Chat")
   *   - 'chat'          → SINGLE-RUNTIME CLI session (Codex / Gemini / opencode).
   *                       NOT the casual chat tab — that's 'llm-chat'.
   *                       Confusing; left as-is to avoid a 75-site rename
   *                       + persisted-state migration. Future cleanup:
   *                       rename 'chat' → 'session'.
   *   - 'terminal'      → tmux/PTY shell tab
   *   - 'canvas'        → file/diff viewer tab
   */
  kind: 'terminal' | 'chat' | 'llm-chat' | 'canvas' | 'orchestrator';
  tmuxSession: string | null;
  cliAgent?: string;
  repo?: RegisteredRepo;
  createdAt: number;
  lastActivity: number;
  chatRuntime?: 'codex' | 'claude-code' | 'gemini' | 'opencode';
  chatSessionKey?: string;
  claudeSessionId?: string;
  chatModel?: string;
  chatContinueLatest?: boolean;
  chatDraftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string };
  llmDraftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string };
  chatMessages?: MobileTranscriptEntry[];
  llmSummary?: string | null;
  chatCheckpoints?: PersistedChatCheckpoint[];
  linkedIssue?: LinkedIssueRef | null;
  canvasTab?: CanvasTab;
  unseen?: boolean;
  orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
  supervisorStatus?: string | null;
  autoArchiveOnIdle?: boolean;
  // Sticky mode for the chooser surface. orchestrator-kind tabs default to
  // 'fleet' and may be 'single' when spawned from the chooser. llm-chat
  // kind tabs are always implicitly chat mode (the field is unset there).
  mode?: OrchestrationMode;
  // When mode === 'single', which runtime this tab dispatches to.
  singleRuntime?: OrchestratorRuntime;
  // Chat-mode model selection (o8 free-tier OpenRouter pool vs BYOK
  // DeepSeek). Used by mode === 'chat' on orchestrator tabs and by all
  // llm-chat tabs.
  chatModelId?: ChatModelId;
  // When set, overrides the server-side OpenRouter fallback chain for
  // chat-mode requests on this tab. Lets the operator pin a specific
  // OpenRouter model slug (e.g. 'openai/gpt-oss-120b:free') for testing
  // or model-tier preference. Empty/undefined = use the env-configured
  // chain.
  chatOpenrouterModel?: string;
}

export type LocalhostPreview = DetectedLocalhostPreview;
export type { PreviewSelectionPayload };
export type WorkspaceChatRuntime = 'codex' | 'claude-code' | 'gemini' | 'opencode' | 'chat';

export interface TerminalTabHandle {
  writeToTerminal: (sessionName: string, data: string) => void;
  writeRaw: (sessionName: string, data: string) => void;
  showImage: (sessionName: string, imageB64: string, filename: string) => void;
  setTermError: (sessionName: string, error: string) => void;
  setTermExited: (sessionName: string) => void;
  onSessionCreated: (sessionName: string, requestId?: string) => boolean;
  clearDetectedPreview: (port: number) => void;
  isRestoreSettled: () => boolean;
  openCliChatSession: (options: {
    runtime?: Exclude<WorkspaceChatRuntime, 'chat'>;
    repo?: RegisteredRepo;
    modelId?: string;
    initialText?: string;
    draftReason?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
    orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
    supervisorStatus?: string | null;
    autoArchiveOnIdle?: boolean;
  }) => string;
  openLlmChatSession: (options?: {
    repo?: RegisteredRepo;
    initialText?: string;
    draftReason?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
  }) => string;
  openOrchestratorTab: () => string;
  openTerminalTab: (repo?: RegisteredRepo) => string;
  openHistoryChat: (
    historyTabId: string,
    title: string,
    repo?: { name?: string; localPath?: string; branch?: string | null; remoteUrl?: string | null } | null,
  ) => string;
  injectIntoCliChat: (text: string, options?: {
    runtime?: Exclude<WorkspaceChatRuntime, 'chat'>;
    repo?: RegisteredRepo;
    modelId?: string;
    draftReason?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
    orchestrationPacket?: WorkspaceOrchestrationPacketBadge | null;
    supervisorStatus?: string | null;
    autoArchiveOnIdle?: boolean;
  }) => string;
  focusTab: (tabId: string) => boolean;
  focusTabRelative: (delta: number) => boolean;
  focusTabAtIndex: (oneBasedIndex: number) => boolean;
  closeActiveTab: () => boolean;
  getTabsSnapshot: () => {
    tabs: Array<{ id: string; label: string; kind: TerminalTab['kind']; sessionKey?: string }>;
    activeTabId: string;
  };
  setOrchestrationPacket: (tabId: string, packet: WorkspaceOrchestrationPacketBadge | null) => boolean;
  updateChatRuntimeStatus: (sessionKey: string, status: string, label?: string) => boolean;
  getChatTabSnapshots: () => OrchestratorLaneSnapshot[];
  openWorkspaceDiff: () => void;
  openInspectorTab: (tab: CanvasTab, options?: { repo?: RegisteredRepo; createNew?: boolean }) => string;
}

export interface WorkspaceTerminalProps {
  stateScope: string;
  defaultTab: 'llm-chat' | 'terminal';
  autoCreateDefaultTab?: boolean;
  preferredRepo?: RegisteredRepo | null;
  splitCreated?: boolean;
  availableRepos?: RegisteredRepo[];
  openRepoPaths?: string[];
  onActiveChatSessionChange?: (sessionKey: string | null) => void;
  onActiveTabKindChange?: (kind: TerminalTab['kind'] | null, tabId: string) => void;
  onChatSessionsChange?: (sessions: MobileInboxSnapshot['sessions']) => void;
  onActiveLaneChange?: (lane: WorkspaceLaneState | null) => void;
  onRepoScopeChange?: (repoPath: string | null) => void;
  onActiveRepoContextChange?: (repo: RegisteredRepo | null) => void;
  onSelectRepoScope?: (repo: RegisteredRepo) => void;
  onLaunchRepoAgent?: (repo: RegisteredRepo) => void | Promise<void>;
  onOpenRepoGitLog?: (repo: RegisteredRepo) => void;
  onOpenRepoCI?: (repo: RegisteredRepo) => void;
  onOpenRepoDiff?: (repo: RegisteredRepo | null) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
  onSplitVertical?: () => void;
  onSplitHorizontal?: () => void;
  canCloseTile?: boolean;
  onCloseTile?: () => void;
  conversationNavigation?: 'tabs' | 'sidebar';
  sendTerminalCreate: (cols: number, rows: number, requestId?: string) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
  termWsConnected: boolean;
  onPreviewDetected?: (preview: DetectedLocalhostPreview) => void;
  onPreviewSelection?: (selection: PreviewSelectionPayload) => void;
  showPreviewPane?: boolean;
}

export interface WorkspaceCliModelOption {
  id: string;
  label: string;
  color: string;
}

export interface QueuedContextCard {
  id: string;
  reason?: string;
  text: string;
  title: string;
  meta: string[];
  preview?: string;
}

export type WorkspaceLlmMessage = LLMMessage;
