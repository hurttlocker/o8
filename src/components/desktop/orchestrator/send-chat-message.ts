import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import type {
  ChatErrorResponse,
  ChatHistoryMessage,
} from '@/lib/chat/types';
import type { ChatModelOption } from './chat-models';

export class ChatSendError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ChatSendError';
    this.status = status;
  }
}

function timestampLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function createChatUserEntry(message: string, timestamp = Date.now()): MobileTranscriptEntry {
  return {
    id: `local-chat-user-${timestamp}`,
    role: 'user',
    text: message,
    timestamp,
    timestampLabel: timestampLabel(timestamp),
  };
}

export function createChatAssistantEntry(modelChoice: ChatModelOption, timestamp = Date.now() + 1): MobileTranscriptEntry {
  return {
    id: `local-chat-assistant-${timestamp}`,
    role: 'assistant',
    text: '',
    timestamp,
    timestampLabel: timestampLabel(timestamp),
    model: modelChoice.label,
  };
}

function toChatHistory(history: MobileTranscriptEntry[]): ChatHistoryMessage[] {
  return history
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .map((entry) => ({
      role: entry.role as ChatHistoryMessage['role'],
      content: entry.text.trim(),
    }))
    .filter((entry) => entry.content.length > 0);
}

function tryOpenClerkSignIn(): boolean {
  const clerk = (window as Window & {
    Clerk?: { openSignIn?: (options?: { afterSignInUrl?: string }) => void };
  }).Clerk;
  if (!clerk?.openSignIn) return false;
  clerk.openSignIn({ afterSignInUrl: window.location.href });
  return true;
}

async function parseErrorResponse(response: Response): Promise<ChatErrorResponse | null> {
  try {
    return await response.json() as ChatErrorResponse;
  } catch {
    return null;
  }
}

function friendlyErrorMessage(status: number, payload: ChatErrorResponse | null): string {
  if (status === 401) {
    const opened = tryOpenClerkSignIn();
    return opened
      ? 'Sign in to use chat. A Clerk sign-in window is open.'
      : 'Sign in to use chat: [open sign-in](/sign-in).';
  }
  if (status === 429) {
    return 'Free chat limit reached for today. Switch to Bring your own key in Settings, or upgrade when paid chat goes live.';
  }
  if (payload?.error === 'byok_key_missing') {
    return 'Add a DeepSeek API key in Settings -> API Keys, then use Bring your own key again.';
  }
  if (payload?.error === 'paid_tier_not_yet_active') {
    return 'Paid chat models are not active yet. Use o8 Default or Bring your own key for now.';
  }
  return payload?.message || `Chat request failed (${status}).`;
}

// ── Scratch chat (OpenRouter free + tools) ──
//
// Used by Chat-mode tabs when chatModelId === 'o8-default'. Calls
// /api/panel/o8-scratch-chat with enableTools:true. The route runs a
// multi-round tool-call loop server-side and streams content + tool_call
// + tool_result events.

interface ScratchChatToolCallEvent {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

interface ScratchChatToolResultEvent {
  id?: string;
  name: string;
  content: string;
}

interface SendScratchChatInput {
  history: MobileTranscriptEntry[];
  message: string;
  context?: {
    repoPath?: string;
    filePath?: string;
    surface?: 'file' | 'diff';
    selection?: string;
    content?: string;
  };
  enableTools?: boolean;
  // Override the server's OpenRouter fallback chain with a single
  // pinned model slug (e.g. 'openai/gpt-oss-120b:free'). Used by the
  // chat-mode model picker.
  modelOverride?: string | null;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onToolCall?: (call: ScratchChatToolCallEvent) => void;
  onToolResult?: (result: ScratchChatToolResultEvent) => void;
  onModel?: (model: string) => void;
}

function parseScratchSseLine(line: string): { type?: string } & Record<string, unknown> | null {
  if (!line.startsWith('data: ')) return null;
  const payload = line.slice(6).trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload) as { type?: string } & Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function sendScratchChatMessage({
  history,
  message,
  context,
  enableTools,
  modelOverride,
  signal,
  onDelta,
  onToolCall,
  onToolResult,
  onModel,
}: SendScratchChatInput): Promise<void> {
  const response = await fetch('/api/panel/o8-scratch-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      history: toChatHistory(history),
      context: context ?? {},
      enableTools: enableTools ?? false,
      modelOverride: modelOverride ?? null,
    }),
    signal,
  });

  if (!response.ok) {
    const payload = await parseErrorResponse(response);
    throw new ChatSendError(response.status, friendlyErrorMessage(response.status, payload));
  }
  if (!response.body) {
    throw new ChatSendError(502, 'Scratch chat stream did not return a response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const event = parseScratchSseLine(line);
      if (!event || typeof event.type !== 'string') continue;
      if (event.type === 'content' && typeof event.text === 'string') {
        onDelta(event.text);
      } else if (event.type === 'tool_call' && typeof event.name === 'string') {
        onToolCall?.({
          id: typeof event.id === 'string' ? event.id : undefined,
          name: event.name,
          args: (event.args && typeof event.args === 'object' && !Array.isArray(event.args))
            ? event.args as Record<string, unknown>
            : {},
        });
      } else if (event.type === 'tool_result' && typeof event.name === 'string') {
        onToolResult?.({
          id: typeof event.id === 'string' ? event.id : undefined,
          name: event.name,
          content: typeof event.content === 'string' ? event.content : '',
        });
      } else if (event.type === 'model' && typeof event.model === 'string') {
        onModel?.(event.model);
      } else if (event.type === 'error' && typeof event.message === 'string') {
        throw new ChatSendError(502, event.message);
      }
    }
  }
}

export function mergeToolCallIntoEntry(
  entry: MobileTranscriptEntry,
  call: ScratchChatToolCallEvent,
): MobileTranscriptEntry {
  const next: MobileTranscriptToolCall = {
    id: call.id ?? null,
    name: call.name,
    args: call.args,
    status: 'running',
  };
  const existing = entry.toolCalls ?? [];
  return { ...entry, toolCalls: [...existing, next] };
}

export function mergeToolResultIntoEntry(
  entry: MobileTranscriptEntry,
  result: ScratchChatToolResultEvent,
): MobileTranscriptEntry {
  const calls = entry.toolCalls ?? [];
  const next = calls.map((call) => {
    const idMatch = result.id && call.id === result.id;
    const nameMatch = !result.id && call.name === result.name && call.status !== 'done';
    if (idMatch || nameMatch) {
      return { ...call, status: 'done' as const, result: result.content };
    }
    return call;
  });
  return { ...entry, toolCalls: next };
}
