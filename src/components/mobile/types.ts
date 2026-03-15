import type {
  Dispatch,
  MutableRefObject,
  ReactNode,
  RefObject,
  SetStateAction,
} from 'react';
import type { ApprovalRequest } from '@/lib/json-render/demo-specs';
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
  expandedProject: string | null;
  selectedSession?: SessionSummary;
  onSessionFocus: (sessionId: string) => void;
  onProjectToggle: (workspace: string | null) => void;
  onCostsView: () => void;
  agentDisplayName: AgentDisplayName;
}

export interface ApprovalStackProps {
  pendingApprovals: ApprovalRequest[];
  resolvedApprovals: Record<string, 'approved' | 'rejected'>;
  onApprove: (approval: ApprovalRequest) => void;
  onReject: (approval: ApprovalRequest) => void;
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
}

export interface ComposeBarHandlers {
  onSend: () => void | Promise<void>;
  onOwnedResume: () => void | Promise<void>;
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
}

export interface ControlsSheetProps {
  controlsOpen: boolean;
  selectedSession?: SessionSummary;
  selectedSessionKey?: string;
  pendingApprovals: ApprovalRequest[];
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
}

export interface DiffOverlayProps {
  diffOpen: boolean;
  selectedFile?: ReviewFileDetail;
  selectedReviewFilePath: string | null;
  reviewFiles: ReviewChangedFile[];
  reviewFileByPath: Record<string, ReviewFileDetail>;
  stickyReviewFilesRef: MutableRefObject<ReviewChangedFile[]>;
  reviewFileError: string | null;
  reviewFileLoadingPath: string | null;
  compactLine: CompactLine;
  onClose: () => void;
  onFileSelect: (reviewPath: string) => void;
  onLoadFile: (reviewPath: string, force?: boolean) => void | Promise<unknown>;
  onRefresh: () => void | Promise<void>;
}

export interface TopBarProps {
  snapshot: MobileInboxSnapshot;
  selectedSession?: SessionSummary;
  selectedReviewPacket?: RuntimeReviewPacket | null;
  selectedReviewFile?: ReviewFileDetail;
  reviewFiles: ReviewChangedFile[];
  isOwnedCodexSession: boolean;
  isHeaderCompact: boolean;
  headerVisible: boolean;
  pendingApprovalsCount: number;
  wsConnectionState?: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  compactLine: CompactLine;
  onOpenControls: () => void;
  onOpenDiff: () => void;
}

export interface SurfaceStatusProps {
  snapshot: MobileInboxSnapshot;
  selectedSession?: SessionSummary;
  selectedReviewPacket?: RuntimeReviewPacket | null;
  isOwnedCodexSession: boolean;
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
