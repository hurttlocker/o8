export type TerminalWorkloadSessionSnapshot = {
  visible: boolean;
  attachedClientCount: number;
  peakAttachedClientCount: number;
  attachEvents: number;
  detachEvents: number;
  pty: {
    visible: { chunks: number; bytes: number };
    hidden: { chunks: number; bytes: number };
  };
  buffer: { events: number; bytesAppended: number; retainedBytes: number };
  replay: { events: number; bytes: number };
  overflow: { events: number; bytes: number };
  backpressureDrops: { events: number; bytes: number };
  fanout: { events: number; sourceBytes: number; clientDeliveries: number };
  alternateScreen: {
    observedEnter: boolean;
    observedExit: boolean;
    retainedEnter: boolean;
    retainedExit: boolean;
  };
  lastOutputTail: string;
  lastOutputAt: number;
};

type MutableSession = TerminalWorkloadSessionSnapshot & { clients: Set<string>; escapeTail: string };

function emptySession(): MutableSession {
  return {
    visible: false,
    attachedClientCount: 0,
    peakAttachedClientCount: 0,
    attachEvents: 0,
    detachEvents: 0,
    pty: {
      visible: { chunks: 0, bytes: 0 },
      hidden: { chunks: 0, bytes: 0 },
    },
    buffer: { events: 0, bytesAppended: 0, retainedBytes: 0 },
    replay: { events: 0, bytes: 0 },
    overflow: { events: 0, bytes: 0 },
    backpressureDrops: { events: 0, bytes: 0 },
    fanout: { events: 0, sourceBytes: 0, clientDeliveries: 0 },
    alternateScreen: { observedEnter: false, observedExit: false, retainedEnter: false, retainedExit: false },
    lastOutputTail: '',
    lastOutputAt: 0,
    clients: new Set(),
    escapeTail: '',
  };
}

export class TerminalWorkloadStats {
  private sessions = new Map<string, MutableSession>();

  private session(sessionName: string): MutableSession {
    let session = this.sessions.get(sessionName);
    if (!session) {
      session = emptySession();
      this.sessions.set(sessionName, session);
    }
    return session;
  }

  reset(attachments: Iterable<{
    sessionName: string;
    clientIds: Set<string>;
    scrollbackBytes: number;
    lastOutputAt: number;
  }>): void {
    this.sessions.clear();
    for (const attachment of attachments) {
      const session = this.session(attachment.sessionName);
      session.clients = new Set(attachment.clientIds);
      session.attachedClientCount = session.clients.size;
      session.peakAttachedClientCount = session.clients.size;
      session.buffer.retainedBytes = attachment.scrollbackBytes;
      session.lastOutputAt = attachment.lastOutputAt;
    }
  }

  setVisibility(sessionName: string, visible: boolean): void {
    this.session(sessionName).visible = visible;
  }

  recordAttach(sessionName: string, clientId: string): void {
    const session = this.session(sessionName);
    if (session.clients.has(clientId)) return;
    session.clients.add(clientId);
    session.attachedClientCount = session.clients.size;
    session.peakAttachedClientCount = Math.max(session.peakAttachedClientCount, session.clients.size);
    session.attachEvents += 1;
  }

  recordDetach(sessionName: string, clientId: string): void {
    const session = this.session(sessionName);
    if (!session.clients.delete(clientId)) return;
    session.attachedClientCount = session.clients.size;
    session.detachEvents += 1;
  }

  recordPty(sessionName: string, data: string, lastOutputAt = Date.now()): void {
    const session = this.session(sessionName);
    const target = session.visible ? session.pty.visible : session.pty.hidden;
    const bytes = Buffer.byteLength(data, 'utf8');
    target.chunks += 1;
    target.bytes += bytes;
    const scanned = `${session.escapeTail}${data}`;
    if (scanned.includes('\x1b[?1049h') || scanned.includes('O8_ALT_SCREEN_ENTER_')) {
      session.alternateScreen.observedEnter = true;
    }
    if (scanned.includes('\x1b[?1049l') || scanned.includes('O8_ALT_SCREEN_EXIT_')) {
      session.alternateScreen.observedExit = true;
    }
    session.escapeTail = scanned.slice(-32);
    session.lastOutputTail = `${session.lastOutputTail}${data}`.slice(-4096);
    session.lastOutputAt = lastOutputAt;
  }

  recordBuffer(sessionName: string, appendedBytes: number, retainedBytes: number): void {
    const buffer = this.session(sessionName).buffer;
    buffer.events += 1;
    buffer.bytesAppended += appendedBytes;
    buffer.retainedBytes = retainedBytes;
  }

  recordOverflow(sessionName: string, bytes: number): void {
    const overflow = this.session(sessionName).overflow;
    overflow.events += 1;
    overflow.bytes += bytes;
  }

  recordReplay(sessionName: string, bytes: number): void {
    const replay = this.session(sessionName).replay;
    replay.events += 1;
    replay.bytes += bytes;
  }

  recordBackpressureDrop(sessionName: string, bytes: number): void {
    const drops = this.session(sessionName).backpressureDrops;
    drops.events += 1;
    drops.bytes += bytes;
  }

  recordFanout(sessionName: string, sourceBytes: number, clientDeliveries: number): void {
    const fanout = this.session(sessionName).fanout;
    fanout.events += 1;
    fanout.sourceBytes += sourceBytes;
    fanout.clientDeliveries += clientDeliveries;
  }

  recordRetainedEscapeState(sessionName: string, retained: string): void {
    const alternate = this.session(sessionName).alternateScreen;
    alternate.retainedEnter = retained.includes('\x1b[?1049h') || retained.includes('O8_ALT_SCREEN_ENTER_');
    alternate.retainedExit = retained.includes('\x1b[?1049l') || retained.includes('O8_ALT_SCREEN_EXIT_');
  }

  snapshot(): { schema: 'o8/terminal-server-stats/v1'; sessions: Record<string, TerminalWorkloadSessionSnapshot> } {
    const sessions: Record<string, TerminalWorkloadSessionSnapshot> = {};
    for (const [sessionName, session] of this.sessions) {
      const { clients: _clients, escapeTail: _escapeTail, ...snapshot } = session;
      void _clients;
      void _escapeTail;
      sessions[sessionName] = structuredClone(snapshot);
    }
    return { schema: 'o8/terminal-server-stats/v1', sessions };
  }
}
