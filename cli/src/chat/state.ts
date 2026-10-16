import { stripVTControlCharacters } from 'node:util';

export interface ChatRoute {
  repoPath: string;
  threadId: string;
  backend: string;
  agent?: string;
  model?: string;
  effort?: string;
  permissionMode?: 'full' | 'plan';
}

export interface ChatTool {
  id: string;
  name: string;
  input: string;
  output?: string;
  status: 'running' | 'done' | 'error';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  tools: ChatTool[];
}

export interface ChatState {
  messages: ChatMessage[];
  cursor: number;
  busy: boolean;
  activity: string;
  error: string | null;
  notice: string | null;
  cost: number | null;
  activeMessageId: string | null;
}

export function initialChatState(): ChatState {
  return { messages: [], cursor: 0, busy: false, activity: 'Ready', error: null,
    notice: null, cost: null, activeMessageId: null };
}

/** Model/tool output is data, never a terminal escape program (including OSC 52). */
export function safeText(value: unknown): string {
  return stripVTControlCharacters(typeof value === 'string' ? value : '')
    .replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function stringify(value: unknown): string {
  return safeText(typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2));
}

export function receiveEvent(state: ChatState, value: unknown, route: ChatRoute): ChatState {
  if (!value || typeof value !== 'object') return state;
  const wire = value as { channel?: string; event?: string; seq?: number; data?: Record<string, unknown> };
  const data = wire.data;
  if (wire.channel !== 'orchestrator' || !data || data.threadId !== route.threadId
    || data.repoPath !== route.repoPath) return state;
  if (typeof wire.seq === 'number' && wire.seq <= state.cursor) return state;
  const next = { ...state, cursor: wire.seq ?? state.cursor,
    messages: state.messages.slice() };
  const messageId = typeof data.assistantMessageId === 'string' ? data.assistantMessageId
    : state.activeMessageId ?? `response-${route.threadId}-${next.cursor}`;
  const assistant = () => {
    const index = next.messages.findIndex((m) => m.id === messageId);
    const existing = index >= 0 ? next.messages[index] : undefined;
    const message: ChatMessage = existing
      ? { ...existing, tools: existing.tools.slice() }
      : { id: messageId, role: 'assistant', text: '', tools: [] };
    if (index >= 0) next.messages[index] = message;
    else next.messages.push(message);
    next.activeMessageId = messageId;
    return message;
  };
  switch (wire.event) {
    case 'output':
      next.busy = true;
      next.activity = data.thinking ? 'Thinking' : 'Writing';
      if (!data.thinking) assistant().text += safeText(data.text);
      break;
    case 'tool-use': {
      const message = assistant();
      const id = typeof data.toolUseId === 'string' ? data.toolUseId : `tool-${next.cursor}`;
      if (!message.tools.some((tool) => tool.id === id)) {
        message.tools.push({ id, name: safeText(data.name), input: stringify(data.args), status: 'running' });
      }
      next.busy = true;
      next.activity = safeText(data.name) || 'Working';
      break;
    }
    case 'tool-result': {
      for (let index = next.messages.length - 1; index >= 0; index -= 1) {
        const message = next.messages[index]!;
        const toolIndex = message.tools.findIndex((tool) => data.toolUseId
          ? tool.id === data.toolUseId : tool.name === data.name && tool.status === 'running');
        if (toolIndex < 0) continue;
        const tools = message.tools.slice();
        tools[toolIndex] = { ...tools[toolIndex]!, output: safeText(data.output), status: data.isError ? 'error' : 'done' };
        next.messages[index] = { ...message, tools };
        break;
      }
      break;
    }
    case 'retry': {
      const message = assistant();
      message.text = '';
      message.tools = [];
      next.notice = safeText(data.notice) || 'The previous attempt was discarded. Retrying.';
      break;
    }
    case 'status':
      // A ready subscription snapshot must not erase a just-submitted turn.
      if (!data.snapshot || !next.busy || data.status === 'busy') {
        next.busy = data.status === 'busy';
        next.activity = next.busy ? 'Working' : data.status === 'dead' ? 'Stopped' : 'Ready';
      }
      if (typeof data.cost === 'number' && Number.isFinite(data.cost)) next.cost = data.cost;
      break;
    case 'error':
      next.error = safeText(data.error) || 'The turn failed.';
      next.busy = false;
      next.activity = 'Needs attention';
      break;
    case 'notice':
      next.notice = safeText(data.message);
      break;
  }
  return next;
}
