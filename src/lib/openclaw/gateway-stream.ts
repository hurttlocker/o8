/**
 * Gateway streaming client — connects to the OpenClaw gateway WebSocket and
 * receives real-time chat deltas. This is a singleton that stays connected
 * and broadcasts events to registered listeners.
 *
 * Architecture:
 *   iPhone ←SSE← Next.js server ←WS← OpenClaw Gateway broadcast
 *
 * The gateway broadcasts { type: "event", event: "chat", payload: { state, message, ... } }
 * to all connected operator clients. We're a read-only consumer — no disruption
 * to existing Telegram/Discord streaming.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──

export type ChatDelta = {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'done' | 'error' | 'aborted';
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
    timestamp: number;
  };
  partialText?: string;
  error?: string;
};

type ChatDeltaListener = (delta: ChatDelta) => void;

type GatewayConfig = {
  port: number;
  token?: string;
};

// ── Gateway config resolution ──

function loadGatewayConfig(): GatewayConfig {
  const configPath = join(
    process.env.HOME ?? '/Users/marquisehurtt',
    '.openclaw',
    'openclaw.json',
  );
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw);
    return {
      port: config?.gateway?.port ?? 18789,
      token: config?.gateway?.auth?.token,
    };
  } catch {
    return { port: 18789 };
  }
}

// ── Protocol frame builders ──

let requestCounter = 0;

function buildRequestFrame(method: string, params: unknown) {
  return JSON.stringify({
    type: 'req',
    id: `cortex-ide-${++requestCounter}`,
    method,
    params,
  });
}

// ── Singleton gateway stream ──

class GatewayStream {
  private ws: WebSocket | null = null;
  private listeners = new Set<ChatDeltaListener>();
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private stopped = false;
  private config: GatewayConfig;
  private instanceId = randomUUID();

  // Buffer the latest delta per session for late-joining SSE clients
  private latestDelta = new Map<string, ChatDelta>();

  constructor() {
    this.config = loadGatewayConfig();
  }

  /** Subscribe to chat delta events. Returns unsubscribe function. */
  subscribe(listener: ChatDeltaListener): () => void {
    this.listeners.add(listener);
    // Auto-connect on first subscriber
    if (this.listeners.size === 1 && !this.ws && !this.connecting) {
      this.ensureStarted();
      this.connect();
    }
    return () => {
      this.listeners.delete(listener);
      // Auto-disconnect when no subscribers
      if (this.listeners.size === 0) {
        this.disconnect();
      }
    };
  }

  /** Get the latest buffered delta for a session (for late-joining clients) */
  getLatestDelta(sessionKey: string): ChatDelta | undefined {
    return this.latestDelta.get(sessionKey);
  }

  /** Check if the gateway connection is active */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.connecting || this.stopped) return;
    this.connecting = true;

    const url = `ws://127.0.0.1:${this.config.port}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('[gateway-stream] WebSocket creation failed:', err);
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[gateway-stream] WebSocket connected to gateway');
      this.backoffMs = 1000;
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(typeof event.data === 'string' ? event.data : String(event.data));
    };

    this.ws.onclose = (event) => {
      console.log(`[gateway-stream] WebSocket closed: ${event.code} ${event.reason}`);
      this.ws = null;
      this.connecting = false;
      if (this.listeners.size > 0 && !this.stopped) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (event) => {
      console.error('[gateway-stream] WebSocket error:', event);
    };
  }

  private handleMessage(raw: string) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    // Step 1: Handle connect.challenge — respond with connect request
    if (parsed.type === 'event' && parsed.event === 'connect.challenge') {
      const payload = parsed.payload as { nonce?: string } | undefined;
      const nonce = payload?.nonce;
      if (!nonce) {
        console.error('[gateway-stream] connect.challenge missing nonce');
        this.ws?.close();
        return;
      }
      this.sendConnect();
      return;
    }

    // Step 2: Handle response to our connect request (hello-ok)
    if (parsed.type === 'res') {
      if (parsed.ok) {
        console.log('[gateway-stream] Connected and authenticated with gateway');
        this.connecting = false;
      } else {
        const error = parsed.error as { message?: string } | undefined;
        console.error('[gateway-stream] Connect failed:', error?.message);
        this.ws?.close();
      }
      return;
    }

    // Step 3: Handle broadcast events
    if (parsed.type === 'event' && parsed.event === 'chat') {
      const delta = parsed.payload as ChatDelta | undefined;
      if (!delta?.sessionKey) return;

      // Buffer latest delta
      this.latestDelta.set(delta.sessionKey, delta);

      // Clear buffer on completion
      if (delta.state === 'done' || delta.state === 'error' || delta.state === 'aborted') {
        // Keep it for 5 seconds for late joiners, then clear
        setTimeout(() => {
          const current = this.latestDelta.get(delta.sessionKey);
          if (current === delta) {
            this.latestDelta.delete(delta.sessionKey);
          }
        }, 5000);
      }

      // Broadcast to all listeners
      for (const listener of this.listeners) {
        try {
          listener(delta);
        } catch (err) {
          console.error('[gateway-stream] listener error:', err);
        }
      }
    }
  }

  private sendConnect() {
    const frame = buildRequestFrame('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        displayName: 'Cortex IDE Mobile',
        version: '0.0.1',
        platform: process.platform,
        mode: 'backend',
        instanceId: this.instanceId,
      },
      caps: [],
      auth: this.config.token ? { token: this.config.token } : undefined,
      role: 'operator',
      scopes: ['operator.read'],
    });
    this.ws?.send(frame);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    console.log(`[gateway-stream] Reconnecting in ${this.backoffMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.listeners.size > 0 && !this.stopped) {
        this.connect();
      }
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
  }

  private disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connecting = false;
    this.latestDelta.clear();
  }

  /** Re-enable after disconnect (for when a new subscriber arrives) */
  private ensureStarted() {
    if (this.stopped) {
      this.stopped = false;
      this.backoffMs = 1000;
    }
  }
}

// Module-level singleton — survives across Next.js API route invocations
// but is properly garbage-collected when the server restarts
const globalForGateway = globalThis as typeof globalThis & { __gatewayStream?: GatewayStream };

export function getGatewayStream(): GatewayStream {
  if (!globalForGateway.__gatewayStream) {
    globalForGateway.__gatewayStream = new GatewayStream();
  }
  return globalForGateway.__gatewayStream;
}
