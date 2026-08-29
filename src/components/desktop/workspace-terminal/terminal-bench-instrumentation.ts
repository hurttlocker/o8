'use client';

export type TerminalBenchVisibilityCounters = {
  calls: number;
  encodedBytes: number;
  decodedBytes: number;
  decodeMs: number;
  writeCallMs: number;
  writeCompletionMs: number;
  renderEvents: number;
  renderRows: number;
};

export type TerminalBenchSessionStats = {
  cols: number;
  rows: number;
  mountCount: number;
  unmountCount: number;
  mounted: boolean;
  visible: boolean;
  visibleMs: number;
  hiddenMs: number;
  visibilityChangedAt: number;
  visibleWork: TerminalBenchVisibilityCounters;
  hiddenWork: TerminalBenchVisibilityCounters;
  readText: (lines?: number) => string;
};

export type TerminalBenchWriteStats = {
  schema: 'o8/terminal-write-stats/v1';
  startedAt: number;
  sessions: Record<string, TerminalBenchSessionStats>;
  transport: {
    terminalMessages: number;
    rawBytes: number;
    encodedBytes: number;
    jsonParseMs: number;
  };
  reset: () => void;
};

declare global {
  interface Window {
    __o8TerminalBenchEnabled?: boolean;
    __o8TerminalWriteStats?: TerminalBenchWriteStats;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function emptyCounters(): TerminalBenchVisibilityCounters {
  return {
    calls: 0,
    encodedBytes: 0,
    decodedBytes: 0,
    decodeMs: 0,
    writeCallMs: 0,
    writeCompletionMs: 0,
    renderEvents: 0,
    renderRows: 0,
  };
}

export function terminalBenchEnabled(): boolean {
  return typeof window !== 'undefined' && window.__o8TerminalBenchEnabled === true;
}

function resetStats(stats: TerminalBenchWriteStats): void {
  const resetAt = now();
  stats.startedAt = resetAt;
  stats.transport = { terminalMessages: 0, rawBytes: 0, encodedBytes: 0, jsonParseMs: 0 };
  for (const session of Object.values(stats.sessions)) {
    session.mountCount = session.mounted ? 1 : 0;
    session.unmountCount = 0;
    session.visibleMs = 0;
    session.hiddenMs = 0;
    session.visibilityChangedAt = resetAt;
    session.visibleWork = emptyCounters();
    session.hiddenWork = emptyCounters();
  }
}

function ensureStats(): TerminalBenchWriteStats | null {
  if (!terminalBenchEnabled()) return null;
  if (window.__o8TerminalWriteStats) return window.__o8TerminalWriteStats;
  const stats: TerminalBenchWriteStats = {
    schema: 'o8/terminal-write-stats/v1',
    startedAt: now(),
    sessions: {},
    transport: { terminalMessages: 0, rawBytes: 0, encodedBytes: 0, jsonParseMs: 0 },
    reset: () => resetStats(stats),
  };
  window.__o8TerminalWriteStats = stats;
  return stats;
}

function settleVisibility(session: TerminalBenchSessionStats, at = now()): void {
  const elapsed = Math.max(0, at - session.visibilityChangedAt);
  if (session.visible) session.visibleMs += elapsed;
  else session.hiddenMs += elapsed;
  session.visibilityChangedAt = at;
}

function sessionStats(sessionName: string): TerminalBenchSessionStats | null {
  return ensureStats()?.sessions[sessionName] ?? null;
}

export function recordTerminalBenchDimensions(sessionName: string, cols: number, rows: number): void {
  const session = sessionStats(sessionName);
  if (!session) return;
  session.cols = cols;
  session.rows = rows;
}

function counters(sessionName: string, visible: boolean): TerminalBenchVisibilityCounters | null {
  const session = sessionStats(sessionName);
  if (!session) return null;
  return visible ? session.visibleWork : session.hiddenWork;
}

export function registerTerminalBenchPanel(
  sessionName: string,
  visible: boolean,
  readText: (lines?: number) => string,
): (() => void) | null {
  const stats = ensureStats();
  if (!stats) return null;
  const at = now();
  const existing = stats.sessions[sessionName];
  if (existing) {
    settleVisibility(existing, at);
    existing.mountCount += 1;
    existing.mounted = true;
    existing.visible = visible;
    existing.readText = readText;
  } else {
    stats.sessions[sessionName] = {
      cols: 0,
      rows: 0,
      mountCount: 1,
      unmountCount: 0,
      mounted: true,
      visible,
      visibleMs: 0,
      hiddenMs: 0,
      visibilityChangedAt: at,
      visibleWork: emptyCounters(),
      hiddenWork: emptyCounters(),
      readText,
    };
  }
  return () => {
    const session = sessionStats(sessionName);
    if (!session) return;
    settleVisibility(session);
    session.unmountCount += 1;
    session.mounted = false;
  };
}

export function recordTerminalBenchVisibility(sessionName: string, visible: boolean): void {
  const session = sessionStats(sessionName);
  if (!session || session.visible === visible) return;
  settleVisibility(session);
  session.visible = visible;
}

export function recordTerminalBenchWrite(
  sessionName: string,
  visible: boolean,
  values: { encodedBytes: number; decodedBytes: number; decodeMs: number; writeCallMs: number },
): void {
  const target = counters(sessionName, visible);
  if (!target) return;
  target.calls += 1;
  target.encodedBytes += values.encodedBytes;
  target.decodedBytes += values.decodedBytes;
  target.decodeMs += values.decodeMs;
  target.writeCallMs += values.writeCallMs;
}

export function recordTerminalBenchWriteCompletion(
  sessionName: string,
  visible: boolean,
  elapsedMs: number,
): void {
  const target = counters(sessionName, visible);
  if (target) target.writeCompletionMs += elapsedMs;
}

export function recordTerminalBenchRender(
  sessionName: string,
  visible: boolean,
  start: number,
  end: number,
): void {
  const target = counters(sessionName, visible);
  if (!target) return;
  target.renderEvents += 1;
  target.renderRows += Math.max(0, end - start + 1);
}

export function recordTerminalBenchTransport(values: {
  rawBytes: number;
  encodedBytes: number;
  jsonParseMs: number;
}): void {
  const stats = ensureStats();
  if (!stats) return;
  stats.transport.terminalMessages += 1;
  stats.transport.rawBytes += values.rawBytes;
  stats.transport.encodedBytes += values.encodedBytes;
  stats.transport.jsonParseMs += values.jsonParseMs;
}

export function settleTerminalBenchStats(): void {
  const stats = ensureStats();
  if (!stats) return;
  const at = now();
  for (const session of Object.values(stats.sessions)) settleVisibility(session, at);
}
