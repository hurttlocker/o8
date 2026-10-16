import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ComposerImageAttachment } from '../../../src/lib/mobile/composer-image-validation.js';
import { apiFetch, CliError, EXIT, resolveWsBase } from '../api.js';
import type { ResolvedConfig } from '../config.js';
import { safeText, type ChatMessage, type ChatRoute } from './state.js';

export interface ThreadHistory {
  repoPath?: string | null;
  backend?: string | null;
  agent?: string | null;
  model?: string | null;
  messages?: Array<{ id: string; role: string; content: string }>;
}

export async function readThread(cfg: ResolvedConfig, id: string): Promise<ThreadHistory> {
  const result = await apiFetch<ThreadHistory>(cfg, '/api/v2/chat-history', {
    query: { tabId: id }, timeoutMs: 10_000,
  });
  if (!result.data || !Array.isArray(result.data.messages)) {
    throw new CliError('invalid_history', 'The server returned an invalid conversation.', EXIT.SERVER_TIMEOUT);
  }
  return result.data;
}

export function historyMessages(history: ThreadHistory): ChatMessage[] {
  return (history.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
    id: m.id, role: m.role as 'user' | 'assistant', text: safeText(m.content), tools: [],
  }));
}

/** Presentation-only client of the existing authenticated desktop transport. */
export class ChatClient {
  private socket: WebSocket | null = null;
  private disposed = false;
  constructor(
    private readonly cfg: ResolvedConfig,
    readonly route: ChatRoute,
    private readonly onEvent: (event: unknown) => void,
    private readonly onDisconnect: () => void,
  ) {}

  async connect(): Promise<void> {
    if (this.cfg.source.token === 'worker') {
      throw new CliError('operator_required', 'Chat requires an operator connection. A worker token cannot control the orchestrator.', EXIT.UNAUTHORIZED);
    }
    const url = new URL('/ws', resolveWsBase(this.cfg));
    if (this.cfg.token) url.searchParams.set('token', this.cfg.token);
    this.disposed = false;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.socket = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(new Error('Chat connection timed out. Run o8 doctor to check the local service.'));
      }, 8_000);
      ws.on('open', () => {
        if (settled) return;
        // An existing turn is reconciled from canonical history. The replay
        // buffer is bounded, so treating it as a complete answer loses prefixes.
        this.write({ type: 'orchestrator-subscribe', ...this.routing() });
      });
      ws.on('message', (raw) => {
        let value: { channel?: string; event?: string; data?: Record<string, unknown> };
        try { value = JSON.parse(raw.toString()); } catch { return; }
        if (value.channel !== 'orchestrator' || value.data?.threadId !== this.route.threadId
          || value.data?.repoPath !== this.route.repoPath) return;
        if (!settled && (value.event === 'status' || value.event === 'error')) {
          settled = true;
          clearTimeout(timer);
          if (value.event === 'error') reject(new Error(safeText(value.data.error) || 'Could not open the conversation.'));
          else resolve();
        }
        this.onEvent(value);
      });
      ws.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Never print the socket URL, which contains a bearer credential.
        reject(new Error('Cannot connect to o8 chat. Start o8 or run o8 doctor.'));
      });
      ws.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('The chat connection closed before it was ready. Check o8 doctor.'));
        }
        if (!this.disposed) this.onDisconnect();
      });
    });
  }

  private routing(): Record<string, string> {
    return { repoPath: this.route.repoPath, threadId: this.route.threadId, backend: this.route.backend,
      ...(this.route.agent ? { agent: this.route.agent } : {}),
    };
  }

  private write(value: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Disconnected. Use /reconnect before sending.');
    this.socket.send(JSON.stringify(value));
  }

  send(message: string, id = randomUUID(), options: { displayMessage?: string; attachments?: ComposerImageAttachment[] } = {}): string {
    this.write({ type: 'orchestrator-send', ...this.routing(),
      clientMessageId: id, message, displayMessage: options.displayMessage ?? message,
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
      permissionMode: this.route.permissionMode ?? 'full',
      ...(this.route.model ? { model: this.route.model } : {}),
      ...(this.route.effort ? { thinkingEffort: this.route.effort } : {}),
    });
    return id;
  }

  interrupt(): void {
    this.write({ type: 'orchestrator-interrupt', ...this.routing(), clientMessageId: randomUUID() });
  }

  close(): void {
    this.disposed = true;
    this.socket?.close();
    this.socket = null;
  }
}
