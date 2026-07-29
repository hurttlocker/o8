import 'server-only';

import { WebSocket } from 'ws';

import {
  DEFAULT_MAX_TUNNEL_BYTES,
  DEFAULT_RELAY_URL,
  httpCancelRequestId,
  RelayHttpRequestRegistry,
  type HttpReqFrame,
} from '@/lib/mobile/relay-connector-protocol';
import { replayRelayHttpRequest } from '@/lib/mobile/relay-http-replay';
import { RelayReconnectPolicy } from '@/lib/mobile/relay-reconnect';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

import type { MachineRelayTicket } from './machine-registry';

const P = '[connect]';
const DEFAULT_HTTP_TIMEOUT_MS = 55_000;
const DEFAULT_REFRESH_INTERVAL_MS = 8 * 60 * 1_000;
const DEFAULT_EXPIRY_LEAD_MS = 2 * 60 * 1_000;

export type { MachineRelayTicket } from './machine-registry';

type ConnectReason = 'attach' | 'reconnect' | 'ticket-refresh';

export interface MachineRelayConnectorConfig {
  machineId: string;
  ticketProvider: () => Promise<MachineRelayTicket>;
  relayUrl?: string;
  apiBase?: string;
  operatorToken?: () => string;
  fetchImpl?: typeof fetch;
  maxTunnelBytes?: number;
  httpRequestTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  refreshIntervalMs?: number;
  expiryLeadMs?: number;
  now?: () => number;
}

/**
 * Persistent machine-scoped relay client. `/machine` deliberately shares the
 * mobile connector's outer mux, HTTP replay, and reconnect policy, while
 * keeping mobile's device E2EE handshake isolated and unchanged.
 */
export class MachineRelayConnector {
  private activeSocket: WebSocket | null = null;
  private candidateSocket: WebSocket | null = null;
  private readonly streams = new Set<string>();
  private readonly httpRequests = new RelayHttpRequestRegistry();
  private readonly reconnect: RelayReconnectPolicy;
  private readonly relayUrl: string;
  private readonly maxTunnelBytes: number;
  private readonly httpRequestTimeoutMs: number;
  private readonly refreshIntervalMs: number;
  private readonly expiryLeadMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly config: MachineRelayConnectorConfig) {
    this.relayUrl = (
      config.relayUrl
      || process.env.O8_RELAY_URL
      || DEFAULT_RELAY_URL
    ).replace(/\/+$/, '');
    this.maxTunnelBytes = config.maxTunnelBytes ?? DEFAULT_MAX_TUNNEL_BYTES;
    this.httpRequestTimeoutMs = positiveInteger(
      config.httpRequestTimeoutMs,
      DEFAULT_HTTP_TIMEOUT_MS,
    );
    this.refreshIntervalMs = positiveInteger(
      config.refreshIntervalMs,
      DEFAULT_REFRESH_INTERVAL_MS,
    );
    this.expiryLeadMs = nonNegativeInteger(
      config.expiryLeadMs,
      DEFAULT_EXPIRY_LEAD_MS,
    );
    this.reconnect = new RelayReconnectPolicy(
      positiveInteger(config.reconnectBaseMs, 1_000),
      positiveInteger(config.reconnectCapMs, 30_000),
    );
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect('attach');
  }

  stop(reason = 'operator-disabled'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.teardownStreams('connector-stop');
    const active = this.activeSocket;
    const candidate = this.candidateSocket;
    this.activeSocket = null;
    this.candidateSocket = null;
    closeSocket(candidate, 'connector stop');
    if (active !== candidate) closeSocket(active, 'connector stop');
    console.log(`${P} detach machineId=${shortId(this.config.machineId)} reason=${reason}`);
  }

  private async connect(reason: ConnectReason): Promise<void> {
    if (this.stopped || this.candidateSocket) return;

    let ticket: MachineRelayTicket;
    try {
      ticket = await this.config.ticketProvider();
      if (!ticket.ticket.trim() || !Number.isFinite(Date.parse(ticket.expiresAt))) {
        throw new Error('invalid relay ticket response');
      }
    } catch (error) {
      console.warn(
        `${P} ${reason} ticket failed machineId=${shortId(this.config.machineId)}: ${errorMessage(error)}`,
      );
      this.scheduleRetry(Boolean(this.activeSocket));
      return;
    }
    if (this.stopped) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${this.relayUrl}/machine`, {
        headers: {
          authorization: `Bearer ${ticket.ticket}`,
          'x-o8-machine-id': this.config.machineId,
        },
      });
    } catch (error) {
      console.warn(
        `${P} ${reason} dial failed machineId=${shortId(this.config.machineId)}: ${errorMessage(error)}`,
      );
      this.scheduleRetry(Boolean(this.activeSocket));
      return;
    }

    this.candidateSocket = socket;
    socket.on('open', () => this.promoteSocket(socket, ticket, reason));
    socket.on('message', (raw) => {
      if (socket === this.activeSocket) this.onRelayMessage(raw);
    });
    socket.on('close', (code, rawReason) => {
      this.onSocketClose(socket, code, rawReason.toString('utf8'));
    });
    socket.on('error', (error) => {
      console.warn(
        `${P} socket error machineId=${shortId(this.config.machineId)}: ${errorMessage(error)}`,
      );
    });
  }

  private promoteSocket(
    socket: WebSocket,
    ticket: MachineRelayTicket,
    reason: ConnectReason,
  ): void {
    if (this.stopped || socket !== this.candidateSocket) {
      closeSocket(socket, 'stale candidate');
      return;
    }
    const previous = this.activeSocket;
    this.activeSocket = socket;
    this.candidateSocket = null;
    this.reconnect.reset();
    this.scheduleTicketRefresh(ticket.expiresAt);

    if (reason === 'ticket-refresh') {
      console.log(`${P} ticket-refresh machineId=${shortId(this.config.machineId)} status=attached`);
    } else {
      console.log(
        `${P} attach machineId=${shortId(this.config.machineId)} relay=${this.relayUrl} reason=${reason}`,
      );
    }
    if (previous && previous !== socket) closeSocket(previous, 'ticket refresh');
  }

  private onSocketClose(socket: WebSocket, code: number, reason: string): void {
    if (socket === this.candidateSocket) {
      this.candidateSocket = null;
      if (!this.stopped) {
        if (!this.activeSocket) this.teardownStreams('stream-teardown');
        this.scheduleRetry(Boolean(this.activeSocket));
      }
      return;
    }
    if (socket !== this.activeSocket) return;

    this.activeSocket = null;
    if (this.stopped) return;
    console.log(
      `${P} detach machineId=${shortId(this.config.machineId)} code=${code} reason=${reason || 'socket-closed'}`,
    );
    if (this.candidateSocket) return;
    this.teardownStreams('stream-teardown');
    this.scheduleRetry(false);
  }

  private scheduleRetry(refreshOnly: boolean): void {
    if (this.stopped) return;
    const delay = this.reconnect.nextDelay();
    if (refreshOnly) {
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        void this.connect('ticket-refresh');
      }, delay);
      this.refreshTimer.unref?.();
      return;
    }

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect('reconnect');
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private scheduleTicketRefresh(expiresAt: string): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const now = (this.config.now ?? Date.now)();
    const expiry = Date.parse(expiresAt);
    const cadenceTarget = now + this.refreshIntervalMs;
    const expiryTarget = expiry - this.expiryLeadMs;
    const minimumDelay = Math.min(1_000, this.refreshIntervalMs);
    const delay = Math.max(minimumDelay, Math.min(cadenceTarget, expiryTarget) - now);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      console.log(`${P} ticket-refresh machineId=${shortId(this.config.machineId)} status=requested`);
      void this.connect('ticket-refresh');
    }, delay);
    this.refreshTimer.unref?.();
  }

  private onRelayMessage(raw: unknown): void {
    const frame = parseRecord(
      typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8'),
    );
    if (!frame) return;
    if (frame.t === 'mux-open' && typeof frame.sid === 'string') {
      this.streams.add(frame.sid);
      this.sendControl({ t: 'mux-ready', sid: frame.sid });
      return;
    }
    if (frame.t === 'mux-close' && typeof frame.sid === 'string') {
      this.teardownStream(frame.sid);
      return;
    }
    if (
      frame.t === 'mux'
      && typeof frame.sid === 'string'
      && typeof frame.payload === 'string'
    ) {
      this.onStreamPayload(frame.sid, frame.payload);
    }
  }

  private onStreamPayload(sid: string, payload: string): void {
    if (!this.streams.has(sid)) return;
    const message = parseRecord(Buffer.from(payload, 'base64').toString('utf8'));
    if (!message) return;

    if (message.t === 'http-cancel') {
      const rid = httpCancelRequestId(message);
      if (rid) this.httpRequests.cancel(sid, rid);
      return;
    }
    if (message.t !== 'http-req') return;

    const apiBase = this.config.apiBase ?? localApiBase();
    const operatorToken = (this.config.operatorToken ?? getOrCreateWsToken)().trim();
    void replayRelayHttpRequest({
      sid,
      request: message as HttpReqFrame,
      apiBase,
      requestRegistry: this.httpRequests,
      timeoutMs: this.httpRequestTimeoutMs,
      maxTunnelBytes: this.maxTunnelBytes,
      isStreamActive: () => this.streams.has(sid),
      send: (response) => this.sendMux(sid, response),
      authorizationOverride: `Bearer ${operatorToken}`,
      fetchImpl: this.config.fetchImpl,
    });
  }

  private sendMux(sid: string, frame: Record<string, unknown>): void {
    this.sendControl({
      t: 'mux',
      sid,
      seq: 0,
      payload: Buffer.from(JSON.stringify(frame), 'utf8').toString('base64'),
    });
  }

  private sendControl(frame: Record<string, unknown>): void {
    try {
      if (this.activeSocket?.readyState === WebSocket.OPEN) {
        this.activeSocket.send(JSON.stringify(frame));
      }
    } catch {
      // Socket close owns retry and stream cleanup.
    }
  }

  private teardownStream(sid: string): void {
    this.httpRequests.abortStream(sid);
    this.streams.delete(sid);
  }

  private teardownStreams(reason: 'connector-stop' | 'stream-teardown'): void {
    this.httpRequests.abortAll(reason);
    this.streams.clear();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.reconnectTimer = null;
    this.refreshTimer = null;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function localApiBase(): string {
  const { apiPort } = resolvePortInfo();
  return `http://127.0.0.1:${apiPort}`;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function closeSocket(socket: WebSocket | null, reason: string): void {
  try {
    socket?.close(1000, reason);
  } catch {
    // Already closed.
  }
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
