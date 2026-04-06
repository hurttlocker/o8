import type { MobileInboxSnapshot, MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { OrchestratorPacket, WorkspaceLaneState } from '@/lib/orchestrator/types';
import type { SidebarRuntimeCapabilities } from '@/lib/chat/sidebar-events';
import type { getSlashCommandSuggestions } from '@/lib/slash-commands';

export type SessionSummary = MobileInboxSnapshot['sessions'][number];

export type TranscriptGroup = {
  id: string;
  kind: 'user' | 'agent' | 'system';
  entries: MobileTranscriptEntry[];
};

export type SessionPickerChipTone = 'blue' | 'green' | 'purple' | 'amber' | 'slate' | 'red';

export type SessionPickerChip = {
  label: string;
  tone: SessionPickerChipTone;
};

export type RuntimeEventSummary = {
  title: string;
  summary: string;
  status?: string;
  task?: string;
  source?: string;
  changedFiles?: string[];
  action?: string;
  rawPreviewLines?: string[];
};

export type GroupChipTone = 'blue' | 'purple' | 'amber' | 'emerald' | 'slate';

export type GroupChip = {
  label: string;
  tone: GroupChipTone;
};

export type GroupSourceCard = {
  id: string;
  label: string;
  summary: string;
  details: string[];
  tone: GroupChipTone;
  links?: Array<{ label: string; href: string }>;
  canOpenDiff?: boolean;
};

export type SidebarApproval = ApprovalRecord;

export type ChatStarterPrompt = {
  label: string;
  detail: string;
  text: string;
};

export interface RenderedBlock {
  element: React.ReactNode;
  rawText: string;
}

export interface BubbleProps {
  entry: MobileTranscriptEntry;
  previousEntry: MobileTranscriptEntry | null;
  agentName: string;
  isNew?: boolean;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
}

export interface AgentPanelChatProps {
  externalSessionKey?: string;
  workspaceSessions?: SessionSummary[];
  workspaceLane?: WorkspaceLaneState | null;
  orchestratorPackets?: OrchestratorPacket[];
  draftInjection?: { id: string; text: string } | null;
  onOpenDiff?: () => void;
  onOpenFile?: (filePath: string, workspace?: string) => void;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
  onSelectSession?: (sessionKey: string) => void;
  onWsStatusChange?: (status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected') => void;
}

export interface DesktopChatHeaderProps {
  pickerRef: React.RefObject<HTMLDivElement | null>;
  pickerOpen: boolean;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  projectGroups: import('@/components/mobile/types').ProjectGroup[];
  selectedSession: SessionSummary | undefined;
  activeTitle: string;
  activeChips: SessionPickerChip[];
  emptyStateLabel: string;
  connectionDotColor: string;
  handleSessionFocus: (sessionId: string) => void;
  expandedGroup: string | null;
  setExpandedGroup: React.Dispatch<React.SetStateAction<string | null>>;
  diffStats: { additions: number; deletions: number; files: number };
  onOpenDiff?: () => void;
  setDiffOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface DesktopTranscriptPaneProps {
  loading: boolean;
  transcript: MobileTranscriptEntry[];
  currentAgentName: string;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
  streamingText: string;
  agentRunning: boolean;
  activityHeadline?: string;
  liveToolCalls?: MobileTranscriptToolCall[];
  onOpenDiff?: () => void;
  onOpenFile?: (filePath: string, workspace?: string) => void;
  currentWorkspace?: string;
  runtimeCapabilities: SidebarRuntimeCapabilities;
  approvals: SidebarApproval[];
  resolvingApprovalId: string | null;
  onResolveApproval: (id: string, action: 'approve' | 'reject') => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  showScrollPill: boolean;
  scrollToBottom: (force?: boolean) => void;
  getIsNewEntry: (entryId: string) => boolean;
  topInset?: number;
}

export interface DesktopComposePaneProps {
  pendingFiles: { name: string; mimeType: string; content: string; preview?: string }[];
  removePendingFile: (idx: number) => void;
  selectedSession: SessionSummary | undefined;
  modelOverride?: string;
  branchOverride?: string;
  statusOverride?: string;
  contextPercentOverride?: number;
  allowAttachments?: boolean;
  composeRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  showSlashSuggestions: boolean;
  slashSuggestions: ReturnType<typeof getSlashCommandSuggestions>;
  composeHeight: number;
  currentAgentName: string;
  send: () => Promise<void>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  enhancing: boolean;
  enhance: () => Promise<void>;
  agentRunning: boolean;
  streamingText: string;
  sending: boolean;
  stopping: boolean;
  stopRun: () => Promise<void>;
  chatSendDisabled: boolean;
  canInterruptSelected: boolean;
}

export interface AgentTurnGroupProps {
  group: TranscriptGroup;
  previousGroup: TranscriptGroup | null;
  transcript: MobileTranscriptEntry[];
  currentAgentName: string;
  getIsNewEntry: (entryId: string) => boolean;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
  onOpenDiff?: () => void;
  onOpenFile?: (filePath: string, workspace?: string) => void;
  currentWorkspace?: string;
}

export interface ActiveTurnCardProps {
  agentName: string;
  text: string;
  activityHeadline?: string;
  liveToolCalls: MobileTranscriptToolCall[];
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
}

export interface SidebarApprovalCardProps {
  approvals: SidebarApproval[];
  resolvingId: string | null;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}

export interface ThinkingXrayProps {
  model: string;
  agentRunning: boolean;
  streamingText: string;
}

export interface ChatEmptyStateProps {
  scopeLabel: string | null;
  title: string;
  body: string;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  prompts: ChatStarterPrompt[];
  onPromptSelect: (prompt: ChatStarterPrompt) => void;
}
