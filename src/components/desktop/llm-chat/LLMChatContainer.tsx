'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFileDrop, MAX_COMPOSER_IMAGES } from '@/lib/hooks/use-file-drop';

import { LLMChatLayout } from './LLMChatLayout';
import {
  API_MODELS, buildOpencodeModels, buildRepoRequestHeaders, CLI_RUNTIME_MODELS, SLASH_COMMANDS,
  type ActiveThinkingState, type AttachedImage, type FileSuggestion, type LLMChatProps, type LLMMessage, type ModelOption, type PendingApprovalState, type QueuedContextCard, type ToolCallInfo,
} from './shared';
import { generateFollowUps, streamAssistantResponse } from './streaming';
import { useHistoryAndMission } from './useHistoryAndMission';
import { useLLMChatLifecycle } from './useLLMChatLifecycle';
import { compactConversation, shouldCompact, type LLMMessage as CompactMessage } from '@/lib/chat/compaction';

export default function LLMChatContainer({ tabId, preferredRepo, linkedIssue, draftInjection, onSummaryChange, onConsumeDraftInjection, onLinkedIssueChange, onOpenInCanvas, onRunInTerminal, onOpenHistoryChat }: LLMChatProps) {
  const [cliModels, setCliModels] = useState<ModelOption[]>([]);
  // null = keys not yet fetched (show all to avoid flicker); Set = configured provider IDs
  const [apiKeyProviders, setApiKeyProviders] = useState<Set<string> | null>(null);
  // Operator is always available — it's o8's branded free tier. Other API models require their key.
  const availableApiModels = apiKeyProviders === null
    ? API_MODELS
    : API_MODELS.filter((m) => (
      m.provider === 'operator'
      || m.provider === 'local'
      || apiKeyProviders.has(m.provider)
    ));
  const allModels = cliModels.length > 0 ? [...cliModels, ...availableApiModels] : availableApiModels;

  const [messages, setMessages] = useState<LLMMessage[]>([]), [input, setInput] = useState(''), [model, setModel] = useState<ModelOption>(API_MODELS[0]), [isStreaming, setIsStreaming] = useState(false), [streamContent, setStreamContent] = useState(''), [modelResolved, setModelResolved] = useState(false);
  const [liveFallbackNotice, setLiveFallbackNotice] = useState<string | null>(null);
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([]), [showFilePicker, setShowFilePicker] = useState(false), [attachedFiles, setAttachedFiles] = useState<string[]>([]), [filePickerIndex, setFilePickerIndex] = useState(0);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]), [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([]), [activeThinking, setActiveThinking] = useState<ActiveThinkingState | null>(null);
  const [followUps, setFollowUps] = useState<string[]>([]), [followUpsLoading, setFollowUpsLoading] = useState(false), [showSlashPicker, setShowSlashPicker] = useState(false), [slashIndex, setSlashIndex] = useState(0);
  const [approvedToolsSet, setApprovedToolsSet] = useState<Set<string>>(new Set()), [pendingApproval, setPendingApproval] = useState<PendingApprovalState | null>(null), [editedCommand, setEditedCommand] = useState(''), [historyOpen, setHistoryOpen] = useState(false);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false), [showTypingIndicator, setShowTypingIndicator] = useState(false), [issuePickerOpen, setIssuePickerOpen] = useState(false), [applyModal, setApplyModal] = useState<{ code: string; language: string } | null>(null);
  const [applyPath, setApplyPath] = useState(''), [applyStatus, setApplyStatus] = useState<'idle' | 'applying' | 'done' | 'error'>('idle'), [applyFileSuggestions, setApplyFileSuggestions] = useState<Array<{ path: string }>>([]), [applyFileIndex, setApplyFileIndex] = useState(0), [queuedContextCards, setQueuedContextCards] = useState<QueuedContextCard[]>([]);

  const dragHostRef = useRef<HTMLDivElement>(null);
  const { pendingFiles: droppedFiles, dragOver, clearPendingFiles: clearDroppedFiles, dragHandlers } = useFileDrop({ enablePaste: false, hostRef: dragHostRef });

  const applySearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null), handledDraftInjectionRef = useRef<string | null>(null), scrollRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLTextAreaElement>(null), abortRef = useRef<AbortController | null>(null), fileSearchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null), saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Real turn-start (epoch ms) for the streaming working indicator. Stamped on
  // every isStreaming false→true edge so a long LLM turn flips to the orbit at
  // the 7-min mark via AgentStatusDot — survives the dot remounting mid-turn.
  const turnStartRef = useRef<number | null>(null);

  // Detect installed CLI runtimes + configured API keys, then build the visible model list.
  // Only models whose CLI is installed OR whose API key is configured will appear in the picker.
  useEffect(() => {
    (async () => {
      try {
        const [detectRes, keysRes] = await Promise.all([
          fetch('/api/setup/detect').catch(() => null),
          fetch('/api/v2/keys').catch(() => null),
        ]);

        if (detectRes?.ok) {
          const data = await detectRes.json();
          const detected: ModelOption[] = [];
          for (const tool of data.tools ?? []) {
            if (!tool.detected) continue;
            if (tool.id === 'opencode') {
              const authedProviders = Array.isArray(tool.details?.authedProviders)
                ? (tool.details.authedProviders as string[])
                : undefined;
              detected.push(...buildOpencodeModels(authedProviders));
            } else if (CLI_RUNTIME_MODELS[tool.id as string]) {
              detected.push(...CLI_RUNTIME_MODELS[tool.id as string]);
            }
          }
          if (detected.length > 0) setCliModels(detected);
        }

        if (keysRes?.ok) {
          const data = await keysRes.json();
          const configured = new Set<string>(
            (data.providers ?? [])
              .filter((p: { configured: boolean }) => p.configured)
              .map((p: { id: string }) => p.id),
          );
          setApiKeyProviders(configured);
        } else {
          setApiKeyProviders(new Set());
        }
      } catch {
        setApiKeyProviders(new Set());
      }
    })();
  }, []);

  const handleApplyToFile = useCallback((code: string, language: string) => {
    setApplyModal({ code, language });
    setApplyPath('');
    setApplyStatus('idle');
    setApplyFileSuggestions([]);
  }, []);

  const handleApplyDiff = useCallback(async (diffText: string) => {
    const repoPath = preferredRepo?.localPath?.trim();
    if (!repoPath) {
      console.error('[diff-card] Failed to apply diff:', new Error('No active repository selected.'));
      return;
    }

    try {
      const response = await fetch('/api/lanes/apply-diff', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildRepoRequestHeaders(preferredRepo ?? null),
        },
        body: JSON.stringify({ diffText, repoPath }),
      });
      const result = await response.json().catch(() => null) as { laneId?: string; error?: string; note?: string } | null;
      if (!response.ok || !result?.laneId) {
        throw new Error(result?.error || result?.note || 'Apply failed');
      }
      window.dispatchEvent(new CustomEvent('o8:lane-lifecycle'));
    } catch (error) {
      console.error('[diff-card] Failed to apply diff:', error);
    }
  }, [preferredRepo]);

  const searchApplyFiles = useCallback((query: string) => {
    if (applySearchTimeout.current) {
      clearTimeout(applySearchTimeout.current);
    }
    if (!query.trim()) {
      setApplyFileSuggestions([]);
      return;
    }
    applySearchTimeout.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/v2/context/files?q=${encodeURIComponent(query)}`, {
          headers: buildRepoRequestHeaders(preferredRepo ?? null),
        });
        if (response.ok) {
          const data = await response.json();
          setApplyFileSuggestions(data.files ?? []);
          setApplyFileIndex(0);
        }
      } catch {}
    }, 100);
  }, [preferredRepo]);

  const doApply = useCallback(async () => {
    if (!applyModal || !applyPath.trim()) return;
    setApplyStatus('applying');
    try {
      const response = await fetch('/api/v2/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: applyPath.trim(),
          content: applyModal.code,
          workspace: preferredRepo?.localPath ?? undefined,
        }),
      });
      if (response.ok) {
        setApplyStatus('done');
        setTimeout(() => {
          setApplyModal(null);
          setApplyStatus('idle');
        }, 1500);
      } else {
        setApplyStatus('error');
      }
    } catch {
      setApplyStatus('error');
    }
  }, [applyModal, applyPath, preferredRepo]);

  const buildPersistedMessages = useCallback((baseMessages: LLMMessage[] = messages, partialContent: string = streamContent) => {
    const stableMessages = isStreaming
      ? baseMessages.filter((message) => !message.isPartial)
      : baseMessages;

    if (isStreaming && partialContent.trim()) {
      return [
        ...stableMessages,
        {
          id: `partial-${tabId}`,
          role: 'assistant' as const,
          content: partialContent,
          model: model.label,
          timestamp: Date.now(),
          isPartial: true,
        },
      ];
    }

    return stableMessages;
  }, [isStreaming, messages, model.label, streamContent, tabId]);

  // Sync dropped files into attachedImages / attachedFiles
  useEffect(() => {
    if (droppedFiles.length === 0) return;
    for (const f of droppedFiles) {
      if (f.mimeType.startsWith('image/')) {
        setAttachedImages((prev) => {
          if (prev.length >= MAX_COMPOSER_IMAGES) return prev;
          return [...prev, { name: f.name, dataUri: `data:${f.mimeType};base64,${f.content}`, mimeType: f.mimeType }];
        });
      } else {
        setAttachedFiles((prev) => [...new Set([...prev, f.name])]);
      }
    }
    clearDroppedFiles();
  }, [droppedFiles, clearDroppedFiles]);

  const handleImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (attachedImages.length >= MAX_COMPOSER_IMAGES) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAttachedImages((current) => [...current, { name: file.name, dataUri: reader.result as string, mimeType: file.type }]);
    };
    reader.readAsDataURL(file);
  }, [attachedImages.length]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`;
    }

    const cursorPos = inputRef.current?.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@([\w./\-]*)$/);

    if (atMatch && atMatch[1].length >= 1) {
      const query = atMatch[1];
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current);
      }
      fileSearchTimeout.current = setTimeout(async () => {
        try {
          const response = await fetch(`/api/v2/context/files?q=${encodeURIComponent(query)}`, {
            headers: buildRepoRequestHeaders(preferredRepo ?? null),
          });
          if (response.ok) {
            const data = await response.json();
            setFileSuggestions(data.files ?? []);
            setShowFilePicker((data.files?.length ?? 0) > 0);
            setFilePickerIndex(0);
          }
        } catch {}
      }, 150);
    } else {
      setShowFilePicker(false);
      setFileSuggestions([]);
    }

    if (value.startsWith('/') && !value.includes(' ')) {
      const query = value.toLowerCase();
      const matches = SLASH_COMMANDS.filter((command) => command.command.startsWith(query));
      setShowSlashPicker(matches.length > 0 && value.length <= 10);
      setSlashIndex(0);
    } else {
      setShowSlashPicker(false);
    }
  }, [preferredRepo]);

  // The pickers' open state is only maintained by the typing handler above —
  // a PROGRAMMATIC clear (send, slash-route, reset) bypasses it and left the
  // commands popup latched open over an empty composer (report FYPPHK).
  // Watch `input` itself so every clear path closes them.
  useEffect(() => {
    if (input.startsWith('/')) return;
    setShowSlashPicker(false);
    if (!input.includes('@')) setShowFilePicker(false);
  }, [input]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].type.startsWith('image/')) {
        event.preventDefault();
        const file = items[index].getAsFile();
        if (file) {
          handleImageFile(file);
        }
        return;
      }
    }
  }, [handleImageFile]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    dragHandlers.onDrop(event);
  }, [dragHandlers]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    dragHandlers.onDragOver(event);
  }, [dragHandlers]);

  const handleFileSelect = useCallback((filePath: string) => {
    const cursorPos = inputRef.current?.selectionStart ?? input.length;
    const textBeforeCursor = input.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@[\w./\-]*$/);
    if (atMatch) {
      const before = textBeforeCursor.slice(0, atMatch.index);
      const after = input.slice(cursorPos);
      setInput(`${before}@${filePath} ${after}`);
    }
    if (!attachedFiles.includes(filePath)) {
      setAttachedFiles((current) => [...current, filePath]);
    }
    setShowFilePicker(false);
    setFileSuggestions([]);
    inputRef.current?.focus();
  }, [attachedFiles, input]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    const normalizedOverrideText = typeof overrideText === 'string' ? overrideText.trim() : null;
    const text = normalizedOverrideText ?? [
      ...queuedContextCards.map((card) => card.text.trim()).filter(Boolean),
      input.trim(),
    ].filter(Boolean).join('\n\n');
    if (!text || isStreaming) return;

    const fileRefs = text.match(/@([\w./\-]+)/g)?.map((ref) => ref.slice(1)) ?? [];
    const allFiles = [...new Set([...attachedFiles, ...fileRefs])];

    let fileContext = '';
    if (allFiles.length > 0) {
      try {
        const response = await fetch('/api/v2/context/files', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildRepoRequestHeaders(preferredRepo ?? null),
          },
          body: JSON.stringify({ paths: allFiles }),
        });
        if (response.ok) {
          const data = await response.json();
          const parts = (data.files ?? [])
            .filter((file: { content: string; error?: string }) => file.content && !file.error)
            .map((file: { path: string; content: string; truncated: boolean }) => (
              `### File: ${file.path}${file.truncated ? ' (truncated)' : ''}\n\`\`\`\n${file.content}\n\`\`\``
            ));
          if (parts.length > 0) {
            fileContext = `\n\n## Attached Files\n${parts.join('\n\n')}`;
          }
        }
      } catch {}
    }

    const userMessage: LLMMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      images: attachedImages.length > 0 ? attachedImages.map((image) => image.dataUri) : undefined,
    };
    setMessages((current) => [...current, userMessage]);
    setInput('');
    setQueuedContextCards([]);
    setAttachedFiles([]);
    setAttachedImages([]);
    setFollowUps([]);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
    }

    const imageMarkdown = attachedImages.map((image, index) => `![Image ${index + 1}](${image.dataUri})`).join('\n');
    const messageForModel = [text, fileContext, imageMarkdown].filter(Boolean).join('\n\n');

    turnStartRef.current = Date.now();
    setIsStreaming(true);
    setShowTypingIndicator(true);
    setStreamContent('');
    setLiveFallbackNotice(null);
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveToolCalls([]);
    setActiveThinking(null);

    try {
      const { assistantMessage, fullContent } = await streamAssistantResponse({
        approvedToolsSet,
        controller,
        disableTools: false,
        linkedIssue,
        messageForModel,
        messages,
        model,
        preferredRepo,
        showTypingIndicator: true,
        tabId,
        onFallback: setLiveFallbackNotice,
        onPendingApproval: (approval, command) => {
          setPendingApproval(approval);
          if (command != null) {
            setEditedCommand(command);
          }
        },
        onStreamContent: setStreamContent,
        onThinking: setActiveThinking,
        onToolCalls: setActiveToolCalls,
        onTypingIndicatorChange: setShowTypingIndicator,
      });

      setMessages((current) => {
        const updated = [...current, assistantMessage];
        if (shouldCompact(updated.length)) {
          const compactableMessages: CompactMessage[] = updated.map((message) => ({
            id: message.id,
            role: message.role as 'user' | 'assistant' | 'system',
            content: message.content,
            timestamp: message.timestamp,
            isError: message.isError,
            isCompaction: message.isCompaction,
            compactedCount: message.compactedCount,
          }));
          compactConversation(compactableMessages, tabId).then((result) => {
            if (result.compactedCount > 0) {
              setMessages(result.newMessages.map((message) => ({
                id: message.id,
                role: message.role as 'user' | 'assistant',
                content: message.content,
                timestamp: message.timestamp ?? Date.now(),
                isCompaction: message.isCompaction,
                compactedCount: message.compactedCount,
              })));
              console.log(`[compaction] Compressed ${result.compactedCount} messages`);
            }
          }).catch((error) => {
            console.error('[compaction] Failed:', error);
          });
        }
        return updated;
      });
      setStreamContent('');
      setActiveThinking(null);

      if (fullContent.length > 20) {
        setFollowUps([]);
        setFollowUpsLoading(true);
        generateFollowUps(fullContent, model, text).then((suggestions) => {
          setFollowUps(suggestions);
          setFollowUpsLoading(false);
        }).catch(() => setFollowUpsLoading(false));
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        if (streamContent) {
          setMessages((current) => [...current, {
            id: `asst-${Date.now()}`,
            role: 'assistant',
            content: `${streamContent}\n\n*[stopped]*`,
            model: model.label,
            timestamp: Date.now(),
          }]);
        }
      } else {
        setMessages((current) => [...current, {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${(error as Error).message}`,
          timestamp: Date.now(),
          isError: true,
        }]);
      }
      setStreamContent('');
    } finally {
      setIsStreaming(false);
      setShowTypingIndicator(false);
      abortRef.current = null;
    }
  }, [approvedToolsSet, attachedFiles, attachedImages, input, isStreaming, linkedIssue, messages, model, preferredRepo, queuedContextCards, streamContent, tabId]);

  const {
    deleteHistory,
    groupedHistory,
    historyItems,
    historyLoading,
    historySearch,
    loadHistory,
    missionCard,
    persistMissionDismissal,
    setHistorySearch,
    shouldShowMissionCard,
    shouldShowSuggestedPrompts,
    toggleStar,
    handleMissionAction,
  } = useHistoryAndMission({
    historyOpen,
    input,
    inputRef,
    isEmpty: messages.length === 0 && !isStreaming,
    onOpenHistoryChat,
    preferredRepo,
    queuedContextCards,
    sendMessage,
    tabId,
  });

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (showFilePicker && fileSuggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setFilePickerIndex((current) => Math.min(current + 1, fileSuggestions.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setFilePickerIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        handleFileSelect(fileSuggestions[filePickerIndex].path);
        return;
      }
      if (event.key === 'Escape') {
        setShowFilePicker(false);
        return;
      }
    }

    if (showSlashPicker) {
      const filtered = SLASH_COMMANDS.filter((command) => command.command.startsWith(input.toLowerCase()));
      const slashMatches = filtered.length;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex((current) => Math.min(current + 1, slashMatches - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        const command = filtered[slashIndex];
        if (command) {
          setInput(command.prefix);
          setShowSlashPicker(false);
          if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 200)}px`;
          }
        }
        return;
      }
      if (event.key === 'Escape') {
        setShowSlashPicker(false);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }, [filePickerIndex, fileSuggestions, handleFileSelect, input, sendMessage, showFilePicker, showSlashPicker, slashIndex]);

  const handleRetryMessage = useCallback((index: number) => {
    const previousMessages = messages.slice(0, index);
    const lastUser = [...previousMessages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return;
    setMessages(previousMessages.filter((message) => message.id !== lastUser.id));
    setInput(lastUser.content);
  }, [messages]);

  const handleEditMessage = useCallback((index: number, content: string) => {
    setInput(content);
    setMessages(messages.slice(0, index));
    inputRef.current?.focus();
  }, [messages]);

  const handleDeleteMessage = useCallback((index: number) => {
    const message = messages[index];
    if (!message) return;
    if (message.role === 'user' && messages[index + 1]?.role === 'assistant') {
      setMessages(messages.filter((_, messageIndex) => messageIndex !== index && messageIndex !== index + 1));
      return;
    }
    if (message.role === 'assistant' && index > 0 && messages[index - 1]?.role === 'user') {
      setMessages(messages.filter((_, messageIndex) => messageIndex !== index && messageIndex !== index - 1));
      return;
    }
    setMessages(messages.filter((_, messageIndex) => messageIndex !== index));
  }, [messages]);

  const handleForkMessage = useCallback((index: number) => {
    const forkedMessages = messages.slice(0, index + 1);
    const forkId = `fork-${Date.now()}`;
    try {
      fetch('/api/v2/chat-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabId: forkId,
          messages: forkedMessages.map((message) => ({ ...message, images: undefined, thinking: undefined })),
          modelId: model.id,
        }),
      });
    } catch {}
    window.dispatchEvent(new CustomEvent('cortex-fork-chat', {
      detail: { forkId, label: `Fork from "${forkedMessages[forkedMessages.length - 1]?.content.slice(0, 30)}..."` },
    }));
  }, [messages, model.id]);

  const handleUploadFiles = useCallback((files: FileList) => {
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          setAttachedImages((current) => [...current.slice(0, 3), { dataUri: reader.result as string, name: file.name, mimeType: file.type }]);
        };
        reader.readAsDataURL(file);
      } else {
        setAttachedFiles((current) => [...new Set([...current, file.name])]);
      }
    }
  }, []);

  const handleApprovePending = useCallback(() => {
    if (!pendingApproval) return;
    const approvalId = pendingApproval.id;
    const toolName = pendingApproval.name;
    const edited = pendingApproval.name === 'run_terminal_command' ? editedCommand.trim() : '';
    setPendingApproval(null);
    setApprovedToolsSet((current) => new Set([...current, toolName]));
    // Re-anchor the turn clock at the resume point so the human approval-wait
    // (isStreaming was false) doesn't count toward the long-running threshold.
    turnStartRef.current = Date.now();
    setIsStreaming(true);
    setShowTypingIndicator(true);
    setStreamContent('');
    setActiveThinking(null);

    fetch('/api/panel/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'approve',
        id: approvalId,
        editedCommand: edited || undefined,
      }),
    }).then(async (response) => {
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        note?: string;
        assistantMessage?: LLMMessage | null;
        nextApproval?: {
          id?: string;
          toolName?: string;
          args?: Record<string, unknown>;
          summary?: string;
          editable?: boolean;
          diff?: { before?: string; after?: string; path?: string };
          command?: string;
        } | null;
        error?: string;
      } | null;

      if (!response.ok || !data?.ok) {
        setMessages((current) => [...current, {
          id: `approval-error-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${data?.error || data?.note || 'Unable to approve this action.'}`,
          timestamp: Date.now(),
          isError: true,
        }]);
        return;
      }

      if (data.assistantMessage) {
        setMessages((current) => [...current, data.assistantMessage as LLMMessage]);
      }

      if (data.nextApproval?.toolName) {
        const isTerminal = data.nextApproval.toolName === 'run_terminal_command';
        setPendingApproval({
          id: data.nextApproval.id,
          name: data.nextApproval.toolName,
          args: data.nextApproval.args ?? {},
          summary: data.nextApproval.summary ?? 'Approval required',
          editable: data.nextApproval.editable ?? isTerminal,
          diff: data.nextApproval.diff,
        });
        if (isTerminal) {
          setEditedCommand(String(data.nextApproval.command || data.nextApproval.args?.command || ''));
        }
      }
    }).catch((error) => {
      setMessages((current) => [...current, {
        id: `approval-error-${Date.now()}`,
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Unable to approve this action.'}`,
        timestamp: Date.now(),
        isError: true,
      }]);
    }).finally(() => {
      setStreamContent('');
      setIsStreaming(false);
      setShowTypingIndicator(false);
    });
  }, [editedCommand, pendingApproval]);

  const handleDenyPending = useCallback(() => {
    if (!pendingApproval) return;
    const approvalId = pendingApproval.id;
    const fallbackSummary = pendingApproval.summary;
    setPendingApproval(null);
    fetch('/api/panel/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', id: approvalId }),
    }).then(async (response) => {
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        assistantMessage?: LLMMessage | null;
        note?: string;
      } | null;
      if (!response.ok || !data?.ok) {
        setMessages((current) => [...current, {
          id: `deny-${Date.now()}`,
          role: 'assistant',
          content: `Action cancelled: ${fallbackSummary}`,
          timestamp: Date.now(),
        }]);
        return;
      }
      if (data.assistantMessage) {
        setMessages((current) => [...current, data.assistantMessage as LLMMessage]);
        return;
      }
      setMessages((current) => [...current, {
        id: `deny-${Date.now()}`,
        role: 'assistant',
        content: data.note || `Action cancelled: ${fallbackSummary}`,
        timestamp: Date.now(),
      }]);
    }).catch(() => {
      setMessages((current) => [...current, {
        id: `deny-${Date.now()}`,
        role: 'assistant',
        content: `Action cancelled: ${fallbackSummary}`,
        timestamp: Date.now(),
      }]);
    });
  }, [pendingApproval]);

  useLLMChatLifecycle({
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
  });

  return (
    <LLMChatLayout
      dragHostRef={dragHostRef}
      dragOver={dragOver}
      onContainerDragOver={dragHandlers.onDragOver}
      onContainerDragLeave={dragHandlers.onDragLeave}
      onContainerDrop={dragHandlers.onDrop}
      activeThinking={activeThinking}
      activeToolCalls={activeToolCalls}
      applyFileIndex={applyFileIndex}
      applyFileSuggestions={applyFileSuggestions}
      applyModal={applyModal}
      applyPath={applyPath}
      applyStatus={applyStatus}
      attachedFiles={attachedFiles}
      attachedImages={attachedImages}
      deleteHistory={deleteHistory}
      editedCommand={editedCommand}
      filePickerIndex={filePickerIndex}
      fileSuggestions={fileSuggestions}
      followUps={followUps}
      followUpsLoading={followUpsLoading}
      groupedHistory={groupedHistory}
      historyItems={historyItems}
      historyLoading={historyLoading}
      historyOpen={historyOpen}
      historySearch={historySearch}
      input={input}
      inputRef={inputRef}
      isEmpty={messages.length === 0 && !isStreaming}
      isStreaming={isStreaming}
      turnStartedAt={turnStartRef.current}
      isUserScrolledUp={isUserScrolledUp}
      issuePickerOpen={issuePickerOpen}
      linkedIssue={linkedIssue}
      loadHistory={loadHistory}
      messages={messages}
      missionCard={missionCard}
      model={model}
      models={allModels}
      onApply={doApply}
      onApplyFileIndexChange={setApplyFileIndex}
      onApplyModalClose={() => setApplyModal(null)}
      onApplyPathChange={(value) => {
        setApplyPath(value);
        if (!value.trim()) setApplyFileSuggestions([]);
      }}
      onApplyToFile={handleApplyToFile}
      onApprovePending={handleApprovePending}
      onAttachedFileRemove={(path) => setAttachedFiles((current) => current.filter((entry) => entry !== path))}
      onAttachedImageRemove={(index) => setAttachedImages((current) => current.filter((_, imageIndex) => imageIndex !== index))}
      onClearFollowUps={() => setFollowUps([])}
      onClose={() => setHistoryOpen(false)}
      onDeleteMessage={handleDeleteMessage}
      onDenyPending={handleDenyPending}
      onEditMessage={handleEditMessage}
      onEditedCommandChange={setEditedCommand}
      onFilePickerIndexChange={setFilePickerIndex}
      onFileSelect={handleFileSelect}
      onFollowUpSelect={setInput}
      onForkMessage={handleForkMessage}
      onHandleInputChange={handleInputChange}
      onHistorySearchChange={setHistorySearch}
      onInputDragOver={handleDragOver}
      onInputDrop={handleDrop}
      onInputKeyDown={handleKeyDown}
      onInputPaste={handlePaste}
      onIssuePickerClose={() => setIssuePickerOpen(false)}
      onIssuePickerOpen={() => setIssuePickerOpen(true)}
      onLinkIssueClear={() => onLinkedIssueChange?.(null)}
      onLinkedIssueChange={onLinkedIssueChange}
      onMissionAction={handleMissionAction}
      onModelSelect={setModel}
      onNewConversation={() => {
        setMessages([]);
        setStreamContent('');
        setFollowUps([]);
      }}
      onOpenHistoryChat={onOpenHistoryChat}
      onOpenInCanvas={onOpenInCanvas}
      onQueuedContextRemove={(id) => setQueuedContextCards((current) => current.filter((card) => card.id !== id))}
      onRetryMessage={handleRetryMessage}
      onRunInTerminal={onRunInTerminal}
      onScrollToBottom={() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
        setIsUserScrolledUp(false);
      }}
      onSend={() => { void sendMessage(); }}
      onSlashIndexChange={setSlashIndex}
      onStop={handleStop}
      onSuggestedPromptSelect={setInput}
      onToggleHistory={() => setHistoryOpen((current) => !current)}
      onUploadFiles={handleUploadFiles}
      onApplyDiff={preferredRepo?.localPath ? handleApplyDiff : undefined}
      pendingApproval={pendingApproval}
      persistMissionDismissal={persistMissionDismissal}
      preferredRepo={preferredRepo}
      queuedContextCards={queuedContextCards}
      scrollRef={scrollRef}
      searchApplyFiles={searchApplyFiles}
      shouldShowMissionCard={shouldShowMissionCard}
      shouldShowSuggestedPrompts={shouldShowSuggestedPrompts}
      showFilePicker={showFilePicker}
      showSlashPicker={showSlashPicker}
      showTypingIndicator={showTypingIndicator}
      slashIndex={slashIndex}
      streamContent={streamContent}
      liveFallbackNotice={liveFallbackNotice}
      toggleStar={toggleStar}
    />
  );
}
