import type { ApprovalDecisionResult, ApprovalRecord } from '@/lib/approvals/types';
import { getApproval, recordApprovalAudit } from '@/lib/approvals/store';
import { issueLlmToolGrant } from '@/lib/approvals/llm-tool-grants';
import {
  readPersistedLlmChat,
  writePersistedLlmChat,
  type PersistedLlmChatHistory,
  type PersistedLlmChatMessage,
} from '@/lib/llm/chat-history-store';
import type { MobileTranscriptSource, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { getOrCreateWsToken } from '@/lib/ws-auth';

function cleanProxyContent(text: string) {
  return text
    .replace(/^I'll use the \w+ tool[^\n]*\n*/gm, '')
    .replace(/^I'll use the \w+ tool[^\n]*/gm, '')
    .replace(/^Let me use[^\n]*tool[^\n]*\n*/gm, '')
    .trim();
}

function ensureHistoryContainsMessages(tabId: string, continuationMessages: Array<{ role: string; content: string }>) {
  const existing = readPersistedLlmChat(tabId)?.history ?? { messages: [] } satisfies PersistedLlmChatHistory;
  const historyMessages = [...(existing.messages ?? [])];
  const existingKeys = new Set(historyMessages.map((message) => `${message.role}:${message.content}`));

  for (const entry of continuationMessages) {
    if (entry.role !== 'user' && entry.role !== 'assistant' && entry.role !== 'system') continue;
    const key = `${entry.role}:${entry.content}`;
    if (existingKeys.has(key)) continue;
    historyMessages.push({
      id: `${entry.role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: entry.role,
      content: entry.content,
      timestamp: Date.now(),
    });
    existingKeys.add(key);
  }

  if (historyMessages.length !== (existing.messages ?? []).length) {
    writePersistedLlmChat(tabId, {
      ...existing,
      messages: historyMessages,
    });
  }

  return readPersistedLlmChat(tabId)?.history ?? { messages: historyMessages } satisfies PersistedLlmChatHistory;
}

function appendAssistantMessage(
  tabId: string,
  message: PersistedLlmChatMessage & { role: 'assistant' },
): PersistedLlmChatMessage & { role: 'assistant' } {
  const existing = readPersistedLlmChat(tabId)?.history ?? { messages: [] } satisfies PersistedLlmChatHistory;
  const last = existing.messages[existing.messages.length - 1];
  if (last?.role === message.role && last.content === message.content) {
    return last as PersistedLlmChatMessage & { role: 'assistant' };
  }
  const next = {
    ...existing,
    model: existing.model ?? message.model,
    messages: [...(existing.messages ?? []), message],
  };
  writePersistedLlmChat(tabId, next);
  return message;
}

export async function resumeLlmApproval(
  requestUrl: string,
  approval: ApprovalRecord,
  options: { actor: 'desktop' | 'mobile'; editedCommand?: string } = { actor: 'desktop' },
): Promise<ApprovalDecisionResult> {
  const continuation = approval.continuation;
  if (!continuation || continuation.kind !== 'llm-chat') {
    return {
      approval,
      note: approval.status === 'approved' ? 'Approval recorded.' : 'Decision recorded.',
    };
  }

  const tabId = continuation.tabId;
  ensureHistoryContainsMessages(tabId, continuation.messages);
  const approvedArgs = { ...(approval.args ?? {}) };
  if (approval.toolName === 'run_terminal_command' && options.editedCommand?.trim()) {
    approvedArgs.command = options.editedCommand.trim();
  }
  const approvalGrant = approval.toolName
    ? issueLlmToolGrant({
        tabId,
        repoPath: continuation.repoPath ?? '',
        toolName: approval.toolName,
        args: approvedArgs,
      })
    : undefined;

  let responseText = '';
  let tokens: { input: number; output: number } | undefined;
  let costUsd: number | undefined;
  let thinkingText = '';
  let toolCalls: MobileTranscriptToolCall[] = [];
  let sources: MobileTranscriptSource[] = [];
  let errorText: string | null = null;
  let nextApproval: ApprovalRecord | null = null;
  let pendingNote: string | null = null;

  const response = await fetch(new URL('/api/v2/proxy/llm', requestUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getOrCreateWsToken()}`,
      'Content-Type': 'application/json',
      'x-tab-id': tabId,
    },
    body: JSON.stringify({
      model: continuation.model,
      provider: continuation.provider,
      messages: continuation.messages,
      repoPath: continuation.repoPath,
      approvalGrant,
    }),
    cache: 'no-store',
  });

  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    const note = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    recordApprovalAudit(approval.id, 'resume_failed', options.actor, note);
    return { approval, note };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n');
    buffer = chunks.pop() ?? '';
    for (const line of chunks) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.type === 'content' && typeof parsed.text === 'string') {
        responseText += parsed.text;
      } else if (parsed.type === 'usage') {
        tokens = {
          input: typeof parsed.inputTokens === 'number' ? parsed.inputTokens : 0,
          output: typeof parsed.outputTokens === 'number' ? parsed.outputTokens : 0,
        };
        costUsd = typeof parsed.costUsd === 'number' ? parsed.costUsd : undefined;
      } else if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
        thinkingText += parsed.text;
      } else if (parsed.type === 'tool_call' && typeof parsed.name === 'string') {
        toolCalls = [...toolCalls, {
          name: parsed.name,
          args: parsed.args && typeof parsed.args === 'object' ? parsed.args as Record<string, unknown> : undefined,
          status: 'done',
        }];
      } else if (parsed.type === 'sources' && Array.isArray(parsed.sources)) {
        sources = parsed.sources as MobileTranscriptSource[];
      } else if (parsed.type === 'approval_required') {
        pendingNote = typeof parsed.summary === 'string' ? parsed.summary : approval.summary;
        if (typeof parsed.id === 'string') {
          nextApproval = getApproval(parsed.id);
        }
      } else if (parsed.type === 'error' && typeof parsed.message === 'string') {
        errorText = parsed.message;
      }
    }
  }

  if (pendingNote) {
    const assistantMessage = appendAssistantMessage(tabId, {
      id: `approval-pending-${Date.now()}`,
      role: 'assistant',
      content: `Approval pending: ${pendingNote}`,
      timestamp: Date.now(),
      model: continuation.model,
    });
    recordApprovalAudit(approval.id, 'resumed', options.actor, 'Approval approved; follow-up approval is pending.');
    // nextApproval omitted when SSE stream lacks an id — mobile re-polls /api/panel/approvals
    return {
      approval,
      assistantMessage,
      ...(nextApproval !== null ? { nextApproval } : {}),
      note: 'Approval recorded. Another approval is required to continue this chat turn.',
    };
  }

  if (errorText) {
    const assistantMessage = appendAssistantMessage(tabId, {
      id: `approval-error-${Date.now()}`,
      role: 'assistant',
      content: `Error: ${errorText}`,
      timestamp: Date.now(),
      model: continuation.model,
      isError: true,
    });
    recordApprovalAudit(approval.id, 'resume_failed', options.actor, errorText);
    return {
      approval,
      assistantMessage,
      note: errorText,
    };
  }

  const finalContent = cleanProxyContent(responseText) || 'Approved action completed.';
  const assistantMessage = appendAssistantMessage(tabId, {
    id: `approval-assistant-${Date.now()}`,
    role: 'assistant',
    content: finalContent,
    timestamp: Date.now(),
    model: continuation.model,
    tokens,
    costUsd,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    sources: sources.length > 0 ? sources : undefined,
    thinking: thinkingText || undefined,
  });
  recordApprovalAudit(approval.id, 'resumed', options.actor, 'Approved tool call resumed successfully.');
  return {
    approval,
    assistantMessage,
    note: 'Approved and resumed the workspace chat turn.',
  };
}

export function rejectLlmApproval(
  approval: ApprovalRecord,
  actor: 'desktop' | 'mobile',
): ApprovalDecisionResult {
  const continuation = approval.continuation;
  if (!continuation || continuation.kind !== 'llm-chat') {
    return {
      approval,
      note: 'Decision recorded.',
    };
  }

  const assistantMessage = appendAssistantMessage(continuation.tabId, {
    id: `approval-reject-${Date.now()}`,
    role: 'assistant',
    content: `Action cancelled: ${approval.summary}`,
    timestamp: Date.now(),
    model: continuation.model,
  });
  recordApprovalAudit(approval.id, 'updated', actor, 'Rejected approval wrote a cancellation note to the shared transcript.');
  return {
    approval,
    assistantMessage,
    note: 'Rejected. The workspace chat turn was cancelled.',
  };
}
