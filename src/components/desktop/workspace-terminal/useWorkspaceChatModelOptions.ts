'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CLAUDE_CLI_MODELS,
  CODEX_CLI_MODELS,
  GEMINI_CLI_MODELS,
  getOpenCodeModels,
} from '@/components/desktop/workspace-terminal/constants';
import type {
  WorkspaceChatRuntime,
  WorkspaceCliModelOption,
} from '@/components/desktop/workspace-terminal/types';
import { getCachedOpenCodeProviders, loadOpenCodeProviders } from '@/lib/setup/detection-cache';

export function useWorkspaceChatModelOptions(
  chatRuntime: WorkspaceChatRuntime | undefined,
  selectedModelId: string | undefined,
): {
  availableModels: WorkspaceCliModelOption[];
  selectedModel: WorkspaceCliModelOption;
  selectedModelLabel: string | undefined;
} {
  const [openCodeProviders, setOpenCodeProviders] = useState<string[]>(() => getCachedOpenCodeProviders());
  const openCodeProvidersLoadedRef = useRef(openCodeProviders.length > 0);

  useEffect(() => {
    if (chatRuntime !== 'opencode' || openCodeProvidersLoadedRef.current) return;
    let cancelled = false;
    void loadOpenCodeProviders().then((providers) => {
      if (!cancelled) { openCodeProvidersLoadedRef.current = true; setOpenCodeProviders(providers); }
    });
    return () => {
      cancelled = true;
    };
  }, [chatRuntime]);

  const availableModels = useMemo<WorkspaceCliModelOption[]>(
    () => {
      if (chatRuntime === 'claude-code') return CLAUDE_CLI_MODELS;
      if (chatRuntime === 'gemini') return GEMINI_CLI_MODELS;
      if (chatRuntime === 'opencode') return getOpenCodeModels(openCodeProviders);
      if (chatRuntime === 'codex' || chatRuntime === undefined) return CODEX_CLI_MODELS;
      return [];
    },
    [chatRuntime, openCodeProviders],
  );
  const selectedModel = useMemo(
    () => availableModels.find((model) => model.id === selectedModelId) ?? (selectedModelId ? { id: selectedModelId, label: selectedModelId, color: 'var(--t-text-secondary)' } : availableModels[0] ?? { id: '', label: 'Agent default', color: 'var(--t-text-secondary)' }),
    [availableModels, selectedModelId],
  );

  return {
    availableModels,
    selectedModel,
    selectedModelLabel: selectedModel?.label,
  };
}
