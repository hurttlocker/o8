import { useEffect } from 'react';

import { saveChatHistory, loadChatHistory, type SavedChatRepoContext } from '@/lib/llm/chat-history';

import { buildConversationSummary, buildQueuedContextCard, HISTORY_DELETED_EVENT, API_MODELS, type AttachedImage, type LLMMessage, type ModelOption, type PendingApprovalState, type PreferredRepoContext, type QueuedContextCard, type ToolCallInfo } from './shared';

export function useLLMChatLifecycle({
  allModels,
  buildPersistedMessages,
  abortRef,
  draftInjection,
  handledDraftInjectionRef,
  inputRef,
  isStreaming,
  isUserScrolledUp,
  messages,
  model,
  modelResolved,
  onConsumeDraftInjection,
  onSummaryChange,
  preferredRepo,
  saveTimerRef,
  scrollRef,
  setActiveThinking,
  setActiveToolCalls,
  setApprovedToolsSet,
  setAttachedFiles,
  setAttachedImages,
  setEditedCommand,
  setFollowUps,
  setInput,
  setIsStreaming,
  setIsUserScrolledUp,
  setMessages,
  setModel,
  setModelResolved,
  setPendingApproval,
  setQueuedContextCards,
  setShowTypingIndicator,
  setStreamContent,
  streamContent,
  tabId,
}: {
  allModels: ModelOption[];
  buildPersistedMessages: (baseMessages?: LLMMessage[], partialContent?: string) => LLMMessage[];
  abortRef: React.RefObject<AbortController | null>;
  draftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string; previewImageDataUri?: string } | null;
  handledDraftInjectionRef: React.RefObject<string | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  isStreaming: boolean;
  isUserScrolledUp: boolean;
  messages: LLMMessage[];
  model: ModelOption;
  modelResolved: boolean;
  onConsumeDraftInjection?: (injectionId: string) => void;
  onSummaryChange?: (tabId: string, summary: string | null) => void;
  preferredRepo?: PreferredRepoContext | null;
  saveTimerRef: React.RefObject<ReturnType<typeof setTimeout> | null>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  setActiveThinking: (value: null) => void;
  setActiveToolCalls: (value: ToolCallInfo[]) => void;
  setApprovedToolsSet: (value: Set<string>) => void;
  setAttachedFiles: (value: string[]) => void;
  setAttachedImages: (value: AttachedImage[]) => void;
  setEditedCommand: (value: string) => void;
  setFollowUps: (value: string[]) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  setIsStreaming: (value: boolean) => void;
  setIsUserScrolledUp: (value: boolean) => void;
  setMessages: React.Dispatch<React.SetStateAction<LLMMessage[]>>;
  setModel: (value: ModelOption) => void;
  setModelResolved: (value: boolean) => void;
  setPendingApproval: (value: PendingApprovalState | null) => void;
  setQueuedContextCards: React.Dispatch<React.SetStateAction<QueuedContextCard[]>>;
  setShowTypingIndicator: (value: boolean) => void;
  setStreamContent: (value: string) => void;
  streamContent: string;
  tabId: string;
}) {
  useEffect(() => {
    const handleHistoryDeleted = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail;
      if (!detail?.tabId || detail.tabId !== tabId) return;
      setMessages([]);
      setInput('');
      setStreamContent('');
      setIsStreaming(false);
      setShowTypingIndicator(false);
      setActiveToolCalls([]);
      setActiveThinking(null);
      setFollowUps([]);
      setAttachedFiles([]);
      setAttachedImages([]);
      setQueuedContextCards([]);
      setPendingApproval(null);
      setEditedCommand('');
      setApprovedToolsSet(new Set());
    };

    window.addEventListener(HISTORY_DELETED_EVENT, handleHistoryDeleted as EventListener);
    return () => window.removeEventListener(HISTORY_DELETED_EVENT, handleHistoryDeleted as EventListener);
  }, [setActiveThinking, setActiveToolCalls, setApprovedToolsSet, setAttachedFiles, setAttachedImages, setEditedCommand, setFollowUps, setInput, setIsStreaming, setMessages, setPendingApproval, setQueuedContextCards, setShowTypingIndicator, setStreamContent, tabId]);

  useEffect(() => {
    onSummaryChange?.(tabId, buildConversationSummary(messages));
  }, [messages, onSummaryChange, tabId]);

  useEffect(() => {
    if (!draftInjection?.id) return;
    if (handledDraftInjectionRef.current === draftInjection.id) return;
    handledDraftInjectionRef.current = draftInjection.id;
    if (draftInjection.autoSend) {
      setInput((current) => {
        const next = draftInjection.text.trim();
        if (!next) return current;
        return current.trim() ? `${next}\n\n${current}` : next;
      });
    } else {
      setQueuedContextCards((current) => current.some((card) => card.id === draftInjection.id) ? current : [...current, buildQueuedContextCard(draftInjection)]);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
    onConsumeDraftInjection?.(draftInjection.id);
  }, [draftInjection, handledDraftInjectionRef, inputRef, onConsumeDraftInjection, setInput, setQueuedContextCards]);

  useEffect(() => {
    if (modelResolved) return;
    (async () => {
      const saved = await loadChatHistory(tabId);
      if (saved?.messages?.length) {
        setMessages(saved.messages);
        if (saved.model) {
          const savedModel = allModels.find((entry) => entry.id === saved.model);
          if (savedModel) {
            setModel(savedModel);
            setModelResolved(true);
            return;
          }
        }
      }
      // o8 Operator is the default for new chats — it's branded, free, and zero-setup.
      // Users can switch to a CLI runtime or another API model via the picker.
      const operatorDefault = allModels.find((entry) => entry.provider === 'operator');
      if (operatorDefault) {
        setModel(operatorDefault);
        setModelResolved(true);
        return;
      }
      // Fallback chain (only hit if the Operator entry was somehow filtered out):
      // first CLI runtime, then any API model with a configured key.
      const cliDefault = allModels.find((entry) => entry.backend === 'cli');
      if (cliDefault) {
        setModel(cliDefault);
        setModelResolved(true);
        return;
      }
      try {
        const response = await fetch('/api/v2/keys');
        if (response.ok) {
          const data = await response.json();
          const configured = new Set((data.providers ?? []).filter((provider: { configured: boolean }) => provider.configured).map((provider: { id: string }) => provider.id));
          const match = API_MODELS.find((entry) => configured.has(entry.provider));
          if (match) setModel(match);
        }
      } catch {}
      setModelResolved(true);
    })();
  }, [allModels, modelResolved, setMessages, setModel, setModelResolved, tabId]);

  useEffect(() => {
    if (!modelResolved) return;
    const persistedMessages = buildPersistedMessages();
    if (persistedMessages.length === 0) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveChatHistory(tabId, persistedMessages, model.id, preferredRepo ?? null as SavedChatRepoContext | null);
    }, isStreaming ? 250 : 1000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [buildPersistedMessages, isStreaming, model.id, modelResolved, preferredRepo, saveTimerRef, tabId]);

  useEffect(() => {
    if (!modelResolved) return;
    const flushHistory = () => {
      const persistedMessages = buildPersistedMessages();
      if (persistedMessages.length === 0) return;
      void saveChatHistory(tabId, persistedMessages, model.id, preferredRepo ?? null as SavedChatRepoContext | null);
    };
    window.addEventListener('pagehide', flushHistory);
    window.addEventListener('beforeunload', flushHistory);
    return () => {
      window.removeEventListener('pagehide', flushHistory);
      window.removeEventListener('beforeunload', flushHistory);
    };
  }, [buildPersistedMessages, model.id, modelResolved, preferredRepo, tabId]);

  useEffect(() => {
    if (scrollRef.current && !isUserScrolledUp) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [isUserScrolledUp, messages, scrollRef, streamContent]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const handleScroll = () => {
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
      setIsUserScrolledUp(distanceFromBottom > 100);
    };
    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [scrollRef, setIsUserScrolledUp]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef, tabId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === 'l') {
        event.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if (event.key === 'Escape' && isStreaming) {
        event.preventDefault();
        abortRef.current?.abort();
        return;
      }
      if (event.key === 'ArrowUp' && !event.shiftKey && document.activeElement === inputRef.current) {
        const value = inputRef.current?.value ?? '';
        if (value === '') {
          event.preventDefault();
          const lastUser = [...messages].reverse().find((message) => message.role === 'user');
          if (lastUser) {
            setInput(lastUser.content);
            setMessages(messages.filter((message) => message.id !== lastUser.id));
            requestAnimationFrame(() => {
              if (!inputRef.current) return;
              inputRef.current.style.height = 'auto';
              inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`;
              inputRef.current.selectionStart = inputRef.current.value.length;
              inputRef.current.selectionEnd = inputRef.current.value.length;
            });
          }
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [abortRef, inputRef, isStreaming, messages, setInput, setIsStreaming, setMessages]);
}
