import { buildLinkedIssueContext, type LinkedIssueRef } from '../IssueLinkPicker';

import { buildRepoRequestHeaders, type ActiveThinkingState, type LLMMessage, MODELS, type ModelOption, type PendingApprovalState, type PreferredRepoContext, type SourceInfo, type ThinkingStep, type ToolCallInfo } from './shared';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';

function normalizeFetchFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/load failed|failed to fetch|networkerror/i.test(message)) {
    return new Error('Network request failed. The app may have refreshed or the local LLM route was unavailable; try sending again.');
  }
  return error instanceof Error ? error : new Error(message || 'Request failed');
}

export async function generateFollowUps(lastResponse: string, model: { id: string; label: string; provider: string }, userQuestion: string): Promise<string[]> {
  try {
    const response = await fetchWithLongLivedBudget('/api/v2/proxy/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model.id,
        provider: model.provider,
        messages: [
          { role: 'system', content: 'Generate exactly 3 brief follow-up questions the user might ask next based on this conversation. Return ONLY the questions, one per line, no numbering, no bullets, no quotes. Keep each under 60 characters. Be specific and insightful, not generic.' },
          { role: 'user', content: `User asked: "${userQuestion.slice(0, 200)}"\n\nAssistant responded: "${lastResponse.slice(0, 500)}"\n\nGenerate 3 follow-up questions:` },
        ],
      }),
    });
    if (!response.ok) return [];
    const reader = response.body?.getReader();
    if (!reader) return [];
    const decoder = new TextDecoder();
    let content = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content') content += parsed.text;
        } catch {}
      }
    }
    return content.split('\n').map((line) => line.replace(/^[\d\.\-\*\)]+\s*/, '').replace(/^["']|["']$/g, '').trim()).filter((line) => line.length > 5 && line.length < 100 && line.includes(' ')).slice(0, 3);
  } catch {
    return [];
  }
}

export async function streamAssistantResponse({
  approvedToolsSet,
  controller,
  disableTools,
  linkedIssue,
  messageForModel,
  messages,
  model,
  preferredRepo,
  showTypingIndicator,
  tabId,
  onFallback,
  onPendingApproval,
  onStreamContent,
  onThinking,
  onToolCalls,
  onTypingIndicatorChange,
}: {
  approvedToolsSet: Set<string>;
  controller: AbortController;
  disableTools?: boolean;
  linkedIssue?: LinkedIssueRef | null;
  messageForModel: string;
  messages: LLMMessage[];
  model: ModelOption;
  preferredRepo?: PreferredRepoContext | null;
  showTypingIndicator: boolean;
  tabId: string;
  onFallback?: (notice: string) => void;
  onPendingApproval: (approval: PendingApprovalState | null, editedCommand?: string) => void;
  onStreamContent: (content: string) => void;
  onThinking: (state: ActiveThinkingState | null) => void;
  onToolCalls: (toolCalls: ToolCallInfo[]) => void;
  onTypingIndicatorChange: (visible: boolean) => void;
}): Promise<{ assistantMessage: LLMMessage; fullContent: string }> {
  const cleanMessages = messages.filter((message) => !message.isError && !message.isPartial && !message.content.startsWith('Error: ') && !message.content.startsWith('Action cancelled:') && Boolean(message.content.trim())).map((message) => ({ role: message.role, content: message.content }));
  const recentMessages = cleanMessages.length > 40 ? cleanMessages.slice(-40) : cleanMessages;

  // Route CLI models to CLI proxy, API models to provider proxy
  const isCli = model.backend === 'cli' && model.cliRuntime;
  const endpoint = isCli ? '/api/v2/proxy/cli' : '/api/v2/proxy/llm';
  const repoPath = preferredRepo?.localPath;
  const requestBody = isCli
    ? JSON.stringify({
        runtime: model.cliRuntime,
        model: model.id,
        messages: [...recentMessages, { role: 'user', content: [buildLinkedIssueContext(linkedIssue), messageForModel].filter(Boolean).join('\n\n') }],
        ...(model.defaultEffort ? { effort: model.defaultEffort } : {}),
        ...(repoPath ? { repoPath } : {}),
      })
    : JSON.stringify({
        model: model.id,
        provider: model.provider,
        messages: [...recentMessages, { role: 'user', content: [buildLinkedIssueContext(linkedIssue), messageForModel].filter(Boolean).join('\n\n') }],
        approvedTools: [...approvedToolsSet],
        ...(disableTools ? { disableTools: true } : {}),
      });

  let response: Response | null = null;
  const retryDelays = [800, 1800];
  for (let attempt = 0; attempt < retryDelays.length + 1; attempt += 1) {
    try {
      response = await fetchWithLongLivedBudget(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tab-id': tabId, ...buildRepoRequestHeaders(preferredRepo ?? null) },
        body: requestBody,
        signal: controller.signal,
      });
      break;
    } catch (error) {
      if (attempt < retryDelays.length && !controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw normalizeFetchFailure(error);
    }
  }
  if (!response) throw new Error('Network request failed. The local LLM route did not return a response.');
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(errorPayload.error || `HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response stream');

  const decoder = new TextDecoder();
  let fullContent = '';
  let tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | undefined;
  let costUsd: number | undefined;
  const toolCalls: ToolCallInfo[] = [];
  const sources: SourceInfo[] = [];
  let thinkingText = '';
  const thinkingSteps: ThinkingStep[] = [];
  const thinkingStartTime = Date.now();
  let isThinking = false;
  let recalledFacts = 0;
  let fallbackNotice = '';
  let typingVisible = showTypingIndicator;

  const hideTypingIndicator = () => {
    if (!typingVisible) return;
    typingVisible = false;
    onTypingIndicatorChange(false);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'thinking') {
          hideTypingIndicator();
          thinkingText += parsed.text;
          if (!isThinking) {
            isThinking = true;
            thinkingSteps.push({ type: 'thinking', label: 'Reasoning through the problem...', status: 'active' });
          }
          onThinking({ steps: [...thinkingSteps], thinking: thinkingText });
          continue;
        }
        if (parsed.type === 'content') {
          if (isThinking) {
            isThinking = false;
            thinkingSteps.forEach((step) => { if (step.status === 'active') step.status = 'complete'; });
            onThinking({ steps: [...thinkingSteps], thinking: thinkingText });
          }
          hideTypingIndicator();
          fullContent += parsed.text;
          onStreamContent(fullContent);
          continue;
        }
        if (parsed.type === 'usage') {
          tokens = {
            input: parsed.inputTokens,
            output: parsed.outputTokens,
            ...(typeof parsed.cacheReadTokens === 'number' ? { cacheRead: parsed.cacheReadTokens } : {}),
            ...(typeof parsed.cacheWriteTokens === 'number' ? { cacheWrite: parsed.cacheWriteTokens } : {}),
          };
          costUsd = parsed.costUsd;
          continue;
        }
        if (parsed.type === 'tool_call') {
          hideTypingIndicator();
          const existing = toolCalls.find((toolCall) => toolCall.name === parsed.name);
          if (existing) {
            existing.status = parsed.status;
            existing.args = parsed.args ?? existing.args;
          } else {
            toolCalls.push({ name: parsed.name, status: parsed.status, args: parsed.args });
          }
          onToolCalls([...toolCalls]);
          const toolLabel = parsed.name === 'search_web' ? `Searching "${parsed.args?.query || ''}"` : parsed.name === 'read_file' ? `Reading ${parsed.args?.path?.split('/').pop() || ''}` : parsed.name === 'search_code' ? `Searching code for "${parsed.args?.query || ''}"` : parsed.name === 'list_files' ? `Listing ${parsed.args?.path || '.'}` : parsed.name === 'create_github_issue' ? 'Creating issue' : parsed.name === 'read_github_issue_or_pr' ? `Reading #${parsed.args?.number || ''}` : parsed.name === 'create_pull_request' ? 'Creating PR' : `Running ${parsed.name}`;
          const existingStep = thinkingSteps.find((step) => step.label === toolLabel);
          if (!existingStep) {
            thinkingSteps.push({ type: parsed.name === 'search_web' || parsed.name === 'search_code' ? 'search' : parsed.name === 'read_file' || parsed.name === 'list_files' ? 'reading' : 'tool', label: toolLabel, status: 'active' });
          }
          onThinking({ steps: [...thinkingSteps], thinking: thinkingText });
          continue;
        }
        if (parsed.type === 'tool_result') {
          const existing = toolCalls.find((toolCall) => toolCall.name === parsed.name);
          if (existing) {
            existing.status = 'done';
            existing.preview = parsed.preview;
          }
          onToolCalls([...toolCalls]);
          const toolStep = [...thinkingSteps].reverse().find((step) => step.status === 'active' && step.type !== 'thinking');
          if (toolStep) toolStep.status = 'complete';
          onThinking({ steps: [...thinkingSteps], thinking: thinkingText });
          continue;
        }
        if (parsed.type === 'memory_recall') {
          recalledFacts = parsed.factCount ?? 0;
          if (recalledFacts > 0) {
            thinkingSteps.push({ type: 'search', label: `Recalled ${recalledFacts} memor${recalledFacts === 1 ? 'y' : 'ies'} from Cortex`, status: 'complete' });
            onThinking({ steps: [...thinkingSteps], thinking: thinkingText });
          }
          continue;
        }
        if (parsed.type === 'approval_required') {
          const isTerminal = parsed.name === 'run_terminal_command';
          onPendingApproval({
            id: typeof parsed.id === 'string' ? parsed.id : undefined,
            name: parsed.name,
            args: parsed.args,
            summary: parsed.summary,
            editable: parsed.editable ?? isTerminal,
            diff: parsed.diff,
          }, isTerminal ? String(parsed.args?.command || '') : undefined);
          continue;
        }
        if (parsed.type === 'sources') {
          sources.push(...(parsed.sources ?? []));
          continue;
        }
        if (parsed.type === 'fallback') {
          const originalLabel = parsed.originalModelLabel
            ?? MODELS.find((entry) => entry.id === parsed.originalModel)?.label
            ?? parsed.originalModel;
          const fallbackLabel = parsed.fallbackModelLabel
            ?? MODELS.find((entry) => entry.id === parsed.fallbackModel)?.label
            ?? parsed.fallbackModel;
          fallbackNotice = `${originalLabel} unavailable — using ${fallbackLabel}`;
          onFallback?.(fallbackNotice);
          continue;
        }
        if (parsed.type === 'error') {
          throw new Error(parsed.message);
        }
      } catch (error) {
        if (error instanceof Error && error.name !== 'SyntaxError' && error.message !== 'Unexpected') {
          throw error;
        }
        if (!line.startsWith('data: [') && !line.startsWith('data: {')) {
          fullContent += data;
          onStreamContent(fullContent);
        }
      }
    }
  }

  const cleanContent = fullContent.replace(/^I'll use the \w+ tool[^\n]*\n*/gm, '').replace(/^I'll use the \w+ tool[^\n]*/gm, '').replace(/^Let me use[^\n]*tool[^\n]*\n*/gm, '').trim();
  const seenSources = new Set<string>();
  const uniqueSources = sources.filter((source) => {
    const key = `${source.title}|${source.url ?? ''}`;
    if (seenSources.has(key)) return false;
    seenSources.add(key);
    return true;
  });

  return {
    assistantMessage: {
      id: `asst-${Date.now()}`,
      role: 'assistant',
      content: cleanContent,
      model: model.label,
      tokens,
      costUsd,
      timestamp: Date.now(),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      sources: uniqueSources.length > 0 ? uniqueSources : undefined,
      thinking: thinkingText || undefined,
      thinkingSteps: thinkingSteps.length > 0 ? thinkingSteps.map((step) => ({ ...step, status: 'complete' as const })) : undefined,
      thinkingDurationMs: thinkingSteps.length > 0 || thinkingText ? Date.now() - thinkingStartTime : undefined,
      recalledFacts: recalledFacts > 0 ? recalledFacts : undefined,
      fallbackNotice: fallbackNotice || undefined,
    },
    fullContent,
  };
}
