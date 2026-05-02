import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type {
  ChatErrorResponse,
  ChatHistoryMessage,
  ChatRequestBody,
  ChatStreamEvent,
} from '@/lib/chat/types';
import type { ChatModelOption } from './chat-models';

interface SendChatMessageInput {
  history: MobileTranscriptEntry[];
  message: string;
  modelChoice: ChatModelOption;
  onDelta: (text: string) => void;
}

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

function parseSseBlock(block: string): ChatStreamEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .join('\n')
    .trim();
  if (!data) return null;
  try {
    return JSON.parse(data) as ChatStreamEvent;
  } catch {
    return null;
  }
}

export async function sendChatMessage({
  history,
  message,
  modelChoice,
  onDelta,
}: SendChatMessageInput): Promise<void> {
  const body: ChatRequestBody = {
    message,
    model: modelChoice.id,
    history: toChatHistory(history),
  };

  const response = await fetch('/api/v2/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = await parseErrorResponse(response);
    throw new ChatSendError(response.status, friendlyErrorMessage(response.status, payload));
  }
  if (!response.body) {
    throw new ChatSendError(502, 'Chat stream did not return a response body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (!event) continue;
      if (event.type === 'content') {
        onDelta(event.text);
      } else if (event.type === 'error') {
        throw new ChatSendError(502, event.message);
      }
    }
  }
}
