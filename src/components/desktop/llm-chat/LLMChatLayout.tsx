import { memo } from 'react';
import type React from 'react';

import { IssueLinkPickerModal, type LinkedIssueRef } from '../IssueLinkPicker';
import { ChatSurface } from './ChatSurface';
import { Composer } from './Composer';
import { HistorySidebar } from './HistorySidebar';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import type { PreferredRepoContext } from './shared';

function LLMChatLayoutBase(props: React.ComponentProps<typeof HistorySidebar> & React.ComponentProps<typeof ChatSurface> & React.ComponentProps<typeof Composer> & {
  issuePickerOpen: boolean;
  linkedIssue?: LinkedIssueRef | null;
  onIssuePickerClose: () => void;
  onLinkedIssueChange?: (issue: LinkedIssueRef | null) => void;
  preferredRepo?: PreferredRepoContext | null;
}) {
  const {
    issuePickerOpen,
    linkedIssue,
    onIssuePickerClose,
    onLinkedIssueChange,
    preferredRepo,
    ...rest
  } = props;

  const historySidebarProps: React.ComponentProps<typeof HistorySidebar> = {
    groupedHistory: rest.groupedHistory,
    historyItems: rest.historyItems,
    historyLoading: rest.historyLoading,
    historyOpen: rest.historyOpen,
    historySearch: rest.historySearch,
    loadHistory: rest.loadHistory,
    onClose: rest.onClose,
    onHistorySearchChange: rest.onHistorySearchChange,
    onOpenHistoryChat: rest.onOpenHistoryChat as ((historyTabId: string, title: string, repo?: SavedChatRepoContext | null) => void) | undefined,
    toggleStar: rest.toggleStar,
    deleteHistory: rest.deleteHistory,
  };

  const chatSurfaceProps: React.ComponentProps<typeof ChatSurface> = {
    activeThinking: rest.activeThinking,
    activeToolCalls: rest.activeToolCalls,
    followUps: rest.followUps,
    followUpsLoading: rest.followUpsLoading,
    inputRef: rest.inputRef,
    isEmpty: rest.isEmpty,
    isStreaming: rest.isStreaming,
    isUserScrolledUp: rest.isUserScrolledUp,
    messages: rest.messages,
    missionCard: rest.missionCard,
    model: rest.model,
    onApplyToFile: rest.onApplyToFile,
    onClearFollowUps: rest.onClearFollowUps,
    onDeleteMessage: rest.onDeleteMessage,
    onEditMessage: rest.onEditMessage,
    onFollowUpSelect: rest.onFollowUpSelect,
    onForkMessage: rest.onForkMessage,
    onMissionAction: rest.onMissionAction,
    onNewConversation: rest.onNewConversation,
    onOpenInCanvas: rest.onOpenInCanvas,
    onRetryMessage: rest.onRetryMessage,
    onRunInTerminal: rest.onRunInTerminal,
    onScrollToBottom: rest.onScrollToBottom,
    onSuggestedPromptSelect: rest.onSuggestedPromptSelect,
    onToggleHistory: rest.onToggleHistory,
    persistMissionDismissal: rest.persistMissionDismissal,
    scrollRef: rest.scrollRef,
    shouldShowMissionCard: rest.shouldShowMissionCard,
    shouldShowSuggestedPrompts: rest.shouldShowSuggestedPrompts,
    showTypingIndicator: rest.showTypingIndicator,
    streamContent: rest.streamContent,
  };

  const composerProps: React.ComponentProps<typeof Composer> = {
    applyFileIndex: rest.applyFileIndex,
    applyFileSuggestions: rest.applyFileSuggestions,
    applyModal: rest.applyModal,
    applyPath: rest.applyPath,
    applyStatus: rest.applyStatus,
    attachedFiles: rest.attachedFiles,
    attachedImages: rest.attachedImages,
    editedCommand: rest.editedCommand,
    filePickerIndex: rest.filePickerIndex,
    fileSuggestions: rest.fileSuggestions,
    input: rest.input,
    inputRef: rest.inputRef,
    isStreaming: rest.isStreaming,
    linkedIssue,
    model: rest.model,
    pendingApproval: rest.pendingApproval,
    queuedContextCards: rest.queuedContextCards,
    showFilePicker: rest.showFilePicker,
    showSlashPicker: rest.showSlashPicker,
    slashIndex: rest.slashIndex,
    onApply: rest.onApply,
    onApplyFileIndexChange: rest.onApplyFileIndexChange,
    onApplyModalClose: rest.onApplyModalClose,
    onApplyPathChange: rest.onApplyPathChange,
    onApprovePending: rest.onApprovePending,
    onAttachedFileRemove: rest.onAttachedFileRemove,
    onAttachedImageRemove: rest.onAttachedImageRemove,
    onDenyPending: rest.onDenyPending,
    onEditedCommandChange: rest.onEditedCommandChange,
    onFilePickerIndexChange: rest.onFilePickerIndexChange,
    onFileSelect: rest.onFileSelect,
    onHandleInputChange: rest.onHandleInputChange,
    onInputDragOver: rest.onInputDragOver,
    onInputDrop: rest.onInputDrop,
    onInputKeyDown: rest.onInputKeyDown,
    onInputPaste: rest.onInputPaste,
    onIssuePickerOpen: rest.onIssuePickerOpen,
    onLinkIssueClear: rest.onLinkIssueClear,
    models: rest.models,
    onModelSelect: rest.onModelSelect,
    onQueuedContextRemove: rest.onQueuedContextRemove,
    onSend: rest.onSend,
    onSlashIndexChange: rest.onSlashIndexChange,
    onStop: rest.onStop,
    onUploadFiles: rest.onUploadFiles,
    searchApplyFiles: rest.searchApplyFiles,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        height: '100%',
        background: '#ffffff',
        fontFamily: '-apple-system, system-ui, sans-serif',
        overflow: 'hidden',
        '--t-text': '#111827',
        '--t-text-strong': '#1e293b',
        '--t-text-secondary': '#6b7280',
        '--t-text-muted': '#5b6475',
        '--t-text-faint': '#8b95a3',
        '--t-divider': 'rgba(0, 0, 0, 0.06)',
        '--t-divider-strong': 'rgba(0, 0, 0, 0.12)',
        '--t-divider-subtle': 'rgba(0, 0, 0, 0.05)',
        '--t-panel-border': 'rgba(0, 0, 0, 0.08)',
        '--t-panel-translucent': 'rgba(255, 255, 255, 0.86)',
        '--t-panel-shadow': '0 18px 40px rgba(15, 23, 42, 0.08)',
        '--t-bg-card': 'rgba(148, 163, 184, 0.08)',
        '--t-input-bg': '#ffffff',
        '--t-input-border': 'rgba(0, 0, 0, 0.1)',
      } as React.CSSProperties}
    >
      <HistorySidebar {...historySidebarProps} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%', position: 'relative' }}>
        <ChatSurface {...chatSurfaceProps} />
        <Composer {...composerProps} />
      </div>
      <IssueLinkPickerModal
        open={issuePickerOpen}
        onClose={onIssuePickerClose}
        value={linkedIssue}
        preferredRepo={preferredRepo ?? null}
        onSelect={(issue) => onLinkedIssueChange?.(issue)}
        onClear={() => onLinkedIssueChange?.(null)}
      />
    </div>
  );
}

export const LLMChatLayout = memo(LLMChatLayoutBase);
