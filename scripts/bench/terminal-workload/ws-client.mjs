import WebSocket from 'ws';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TerminalWorkloadClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.frames = [];
    this.textBySession = new Map();
    this.deliveryBySession = new Map();
    this.textArrivalWatches = new Map();
    this.benchStatsRequests = 0;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString('utf8')); } catch { return; }
      this.frames.push(frame);
      if (this.frames.length > 4000) this.frames.splice(0, 2000);
      if (frame.channel === 'terminal' && frame.event === 'data') {
        const sessionName = frame.data?.sessionName;
        const encoded = frame.data?.data;
        if (typeof sessionName === 'string' && typeof encoded === 'string') {
          const decoded = Buffer.from(encoded, 'base64');
          const delivery = this.deliveryBySession.get(sessionName) ?? { frames: 0, bytes: 0 };
          delivery.frames += 1;
          delivery.bytes += decoded.byteLength;
          this.deliveryBySession.set(sessionName, delivery);
          const next = `${this.textBySession.get(sessionName) ?? ''}${decoded.toString('utf8')}`;
          this.textBySession.set(sessionName, next.slice(-131072));
          for (const watch of this.textArrivalWatches.values()) {
            if (watch.sessionName === sessionName && watch.receivedAt === null && next.includes(watch.marker)) {
              watch.receivedAt = Date.now();
            }
          }
        }
      }
    });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    await this.waitForFrame((frame) => frame.channel === 'system' && frame.event === 'connected', 10000);
    return this;
  }

  terminalDelivery(sessionName) {
    return { ...(this.deliveryBySession.get(sessionName) ?? { frames: 0, bytes: 0 }) };
  }

  watchTextArrival(sessionName, marker) {
    const key = `${sessionName}\u0000${marker}`;
    this.textArrivalWatches.set(key, { sessionName, marker, receivedAt: null });
  }

  textArrival(sessionName, marker) {
    const watch = this.textArrivalWatches.get(`${sessionName}\u0000${marker}`);
    return watch ? { receivedAt: watch.receivedAt } : null;
  }

  unwatchTextArrival(sessionName, marker) {
    this.textArrivalWatches.delete(`${sessionName}\u0000${marker}`);
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('terminal workload socket is not open');
    this.socket.send(JSON.stringify(message));
  }

  async waitForFrame(predicate, timeoutMs = 10000, startIndex = 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.frames.slice(startIndex).find(predicate);
      if (match) return match;
      if (this.socket?.readyState === WebSocket.CLOSED) throw new Error('terminal workload socket closed');
      await sleep(20);
    }
    throw new Error(`timed out waiting for terminal workload frame after ${timeoutMs}ms`);
  }

  async request(type, message = {}, timeoutMs = 10000) {
    const requestId = `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const startIndex = this.frames.length;
    if (type === 'terminal-bench-stats') this.benchStatsRequests += 1;
    this.send({ type, requestId, ...message });
    return this.waitForFrame(
      (frame) => frame.channel === 'terminal-bench' && frame.data?.requestId === requestId,
      timeoutMs,
      startIndex,
    );
  }

  async createAndAttach({ ownerKey, requestId, sessionName, cwd, cols = 120, rows = 30, visible = false }) {
    let startIndex = this.frames.length;
    this.send({ type: 'terminal-create', ownerKey, requestId, cwd, cols, rows });
    const created = await this.waitForFrame(
      (frame) => frame.channel === 'terminal' && frame.event === 'created' && frame.data?.requestId === requestId,
      15000,
      startIndex,
    );
    if (created.data?.sessionName !== sessionName) {
      throw new Error(`owner key resolved to ${created.data?.sessionName ?? 'no session'}, expected ${sessionName}`);
    }
    startIndex = this.frames.length;
    this.send({ type: 'terminal-attach', sessionName, cols, rows });
    await this.waitForFrame(
      (frame) => frame.channel === 'terminal' && frame.event === 'attached' && frame.data?.sessionName === sessionName,
      15000,
      startIndex,
    );
    this.send({ type: 'terminal-visibility', sessionName, visible, epoch: 1 });
  }

  async waitForText(sessionName, marker, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((this.textBySession.get(sessionName) ?? '').includes(marker)) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${marker} on ${sessionName}`);
  }

  async waitForServerText(sessionName, marker, timeoutMs = 30000) {
    await this.waitForServerTexts([{ sessionName, marker }], timeoutMs);
  }

  async waitForServerTexts(markers, timeoutMs = 30000, pollIntervalMs = 250) {
    const pending = new Map(markers.map(({ sessionName, marker }) => [sessionName, marker]));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = (await this.request('terminal-bench-stats')).data?.snapshot;
      for (const [sessionName, marker] of pending) {
        if (snapshot?.sessions?.[sessionName]?.lastOutputTail?.includes(marker)) pending.delete(sessionName);
      }
      if (pending.size === 0) return;
      await sleep(pollIntervalMs);
    }
    const pendingMarkers = [...pending].map(([sessionName, marker]) => ({ sessionName, marker }));
    const error = new Error(`timed out waiting for server output ${pendingMarkers.map(({ marker, sessionName }) => `${marker} on ${sessionName}`).join(', ')}`);
    error.pendingServerMarkers = pendingMarkers;
    throw error;
  }

  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.close();
      setTimeout(resolve, 1000).unref();
    });
  }
}

export async function connectTerminalClients(url, count) {
  const clients = [];
  for (let index = 0; index < count; index += 1) {
    clients.push(await new TerminalWorkloadClient(url).connect());
  }
  return clients;
}
