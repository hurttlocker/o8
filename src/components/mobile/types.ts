import type {
  Dispatch,
  MutableRefObject,
  ReactNode,
  RefObject,
  SetStateAction,
} from 'react';
import type { MobileApprovalCard } from '@/lib/approvals/types';
import type { ReviewChangedFile, RuntimeReviewPacket } from '@/lib/fleet/types';
import type {
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
} from '@/lib/mobile/types';

export type SessionSummary = MobileInboxSnapshot['sessions'][number];
export type ReviewFileDetail = MobileReviewFileResponse['file'];

export type CompactLine = (
  text: string | null | undefined,
  fallback: string,
  max?: number,
) => string;

export type AgentDisplayName = (session: SessionSummary) => string;
export type RenderMessageBody = (text: string, keyPrefix: string) => ReactNode;

export type ActionState = 'idle' | 'steering' | 'stopping' | 'reviewing';
export type MobileOrchestratorStatus = 'hidden' | 'connecting' | 'ready' | 'busy' | 'error' | 'dead';

export interface DraftAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  content: string;
  previewUrl: string;
}

export interface PendingOwnedTurn {
  id: string;
  prompt: string;
  createdAt: number;
  timestampLabel: string;
}

export interface ProjectGroup {
  projectName: string;
  workspace: string;
  sessions: SessionSummary[];
  hasPrimary: boolean;
  summary: string;
  mostRecentTime?: string;
  bestContextPct: number;
  hasRunning: boolean;
}

export interface TokenUsageSummaryProps {
  snapshot: MobileInboxSnapshot;
  onViewCosts: () => void;
}

export interface CostsDashboardProps {
  snapshot: MobileInboxSnapshot;
  onBack: () => void;
  onSessionSelect: (sessionId: string) => void;
  compactLine: CompactLine;
}

export interface SquadRailProps {
  snapshot: MobileInboxSnapshot;
  selectedSession?: SessionSummary;
  onSessionFocus: (sessionId: string) => void;
  onLaunch: () => void;
  compactLine: CompactLine;
}

export interface ApprovalStackProps {
  pendingApprovals: MobileApprovalCard[];
  resolvedApprovals: Record<string, 'approved' | 'rejected'>;
  onApprove: (approval: MobileApprovalCard) => void;
  onReject: (approval: MobileApprovalCard) => void;
}

export interface ChatViewProps {
  transcriptEntries: MobileTranscriptEntry[];
  transcriptLoading: boolean;
  isRefreshing?: boolean;
  composeHeight?: number;
  selectedSession?: SessionSummary;
  selectedReviewFile?: ReviewFileDetail;
  streamingText: string;
  waitingForResponse: boolean;
  actionState: ActionState;
  hydrated: boolean;
  isOwnedCodexSession: boolean;
  seenMessageIdsRef: MutableRefObject<Set<string> | null>;
  agentDisplayName: AgentDisplayName;
  renderMessageBody: RenderMessageBody;
  expandedMedia: MobileTranscriptMedia | null;
  setExpandedMedia: Dispatch<SetStateAction<MobileTranscriptMedia | null>>;
  onOpenDiff: () => void;
  onScrollToLatestMessage: (force?: boolean) => void;
  onLoadMore?: () => Promise<number>;
  hasMoreHistory?: boolean;
}

export interface ComposeBarHandlers {
  onSend: (sessionKey?: string) => void | Promise<void>;
  onOwnedResume: (sessionKey?: string) => void | Promise<void>;
  onEnhance: () => void | Promise<void>;
  onUndoEnhance: () => void;
  onAttach: () => void;
  onAttachFiles: (files: FileList | null) => void | Promise<void>;
  onRemoveAttachment: (attachmentId: string) => void;
  onRefresh: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onInterrupt: () => void | Promise<void>;
  onOpenDiff: () => void;
  onLoadCorrectionDraft: () => void;
  onToggleOwnedReviewDisposition: () => void | Promise<void>;
  onDraftChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
}

export interface ComposeBarProps {
  session?: SessionSummary;
  sessionKey?: string;
  draft: string;
  attachments: DraftAttachment[];
  actionState: ActionState;
  enhancing: boolean;
  preEnhanceDraft: string | null;
  isChatSession: boolean;
  canResumeOwnedCodex: boolean;
  canInterruptOwnedCodex: boolean;
  selectedReviewPacket?: RuntimeReviewPacket | null;
  reviewFiles: ReviewChangedFile[];
  ownedAvailability?: string;
  ownedReviewDisposition?: RuntimeReviewPacket['reviewDisposition'];
  ownedQueuedTurn: boolean;
  surfaceRefreshing: boolean;
  actionNote?: string | null;
  compactLine: CompactLine;
  agentDisplayName: AgentDisplayName;
  composeRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handlers: ComposeBarHandlers;
  onOpenRecall?: () => void;
  onModelPillTap?: () => void;
  streamingText?: string;
  agentRunning?: boolean;
}

export interface ControlsSheetProps {
  controlsOpen: boolean;
  selectedSession?: SessionSummary;
  selectedSessionKey?: string;
  pendingApprovals: MobileApprovalCard[];
  sessionSwitcher: SessionSummary[];
  reviewFiles: ReviewChangedFile[];
  surfaceRefreshing: boolean;
  isChatSession: boolean;
  isOwnedCodexSession: boolean;
  canInterruptOwnedCodex: boolean;
  compactLine: CompactLine;
  onClose: () => void;
  onRefresh: () => void | Promise<void>;
  onOpenDiff: () => void;
  onToggleApprovals: () => void;
  onCopyKey: () => void;
  onAbort: () => void | Promise<void>;
  onSessionFocus: (sessionId: string) => void;
  onSearchSelectSession?: (sessionKey: string) => void;
  onSearchSelectIssue?: (issueNumber: number) => void;
  children?: ReactNode;
}

export interface DiffOverlayProps {
  diffOpen: boolean;
  selectedFile?: ReviewFileDetail;
  selectedReviewFilePath: string | null;
  reviewFiles: ReviewChangedFile[];
  reviewFileByPath: Record<string, ReviewFileDetail>;
  stickyReviewFiles: ReviewChangedFile[];
  reviewFileError: string | null;
  reviewFileLoadingPath: string | null;
  compactLine: CompactLine;
  onClose: () => void;
  onFileSelect: (reviewPath: string) => void;
  onLoadFile: (reviewPath: string, force?: boolean) => void | Promise<unknown>;
  onRefresh: () => void | Promise<void>;
}

export interface TopBarProps {
  selectedSession?: SessionSummary;
  headerVisible: boolean;
  pendingApprovalsCount: number;
  activeView: 'squad' | 'chat' | 'costs' | 'fleet' | 'activity' | 'settings' | 'issues';
  compactLine: CompactLine;
  activeScreen: import('./SpeedDial').MobileScreen;
  enabledViews: ReadonlySet<string>;
  onNavigate: (screen: import('./SpeedDial').MobileScreen) => void;
  onNewChat?: () => void;
  onOpenControls: () => void;
}

export interface SurfaceStatusProps {
  snapshot: MobileInboxSnapshot;
  selectedSession?: SessionSummary;
  selectedReviewPacket?: RuntimeReviewPacket | null;
  isOwnedCodexSession: boolean;
  orchestratorStatus?: MobileOrchestratorStatus;
  orchestratorNote?: string | null;
  refreshError?: string | null;
  surfaceNote?: string | null;
  transcriptError?: string | null;
  selectedReviewPacketError?: string | null;
}

export interface RuntimeBarProps {
  snapshot: MobileInboxSnapshot;
  selectedSession?: SessionSummary;
  selectedReviewPacket?: RuntimeReviewPacket | null;
  isOwnedCodexSession: boolean;
  compactLine: CompactLine;
}

export interface MediaLightboxProps {
  media: MobileTranscriptMedia | null;
  onClose: () => void;
}
