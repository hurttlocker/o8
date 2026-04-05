import type { CanvasRepoTaskLaunchRequest, CanvasTab } from '@/components/desktop/Canvas';
import type { LLMMessage } from '@/components/desktop/LLMChat';
import type { LinkedIssueRef } from '@/components/desktop/IssueLinkPicker';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';
import type { RepoReadiness } from '@/lib/repos/types';
import type { PersistedChatCheckpoint } from '@/lib/terminal/tab-state';
import type {
  OrchestratorLaneSnapshot,
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
  kind: 'terminal' | 'chat' | 'llm-chat' | 'canvas';
  tmuxSession: string | null;
  cliAgent?: string;
  repo?: RegisteredRepo;
  createdAt: number;
  lastActivity: number;
  chatRuntime?: 'codex' | 'claude-code';
  chatSessionKey?: string;
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
}

export type LocalhostPreview = DetectedLocalhostPreview;
export type { PreviewSelectionPayload };
export type WorkspaceChatRuntime = 'codex' | 'claude-code' | 'chat';

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
    runtime?: 'codex' | 'claude-code';
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
  injectIntoCliChat: (text: string, options?: {
    runtime?: 'codex' | 'claude-code';
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
