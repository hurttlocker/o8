// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordTerminalBenchDelivery,
  recordTerminalBenchPaint,
  registerTerminalBenchPanel,
} from './terminal-bench-instrumentation';

describe('terminal benchmark text timestamps', () => {
  beforeEach(() => {
    window.__o8TerminalBenchEnabled = true;
    delete window.__o8TerminalWriteStats;
  });

  afterEach(() => {
    delete window.__o8TerminalBenchEnabled;
    delete window.__o8TerminalWriteStats;
  });

  it('records delivery and painted timestamps for a watched marker', () => {
    registerTerminalBenchPanel('bench-session', true, () => '');
    const session = window.__o8TerminalWriteStats?.sessions['bench-session'];
    session?.watchText('O8K_MARKER');

    recordTerminalBenchDelivery('bench-session', new TextEncoder().encode('prefix O8K_MARKER suffix'));
    const delivered = session?.textWatch('O8K_MARKER');
    expect(delivered?.deliveredAt).toEqual(expect.any(Number));
    expect(delivered?.paintedAt).toBeNull();

    recordTerminalBenchPaint('bench-session', () => 'visible O8K_MARKER');
    expect(session?.textWatch('O8K_MARKER')?.paintedAt).toEqual(expect.any(Number));
  });

  it.each([
    ['one coalesced chunk', ['prefix O8K_MARKER' + 'x'.repeat(4096)]],
    ['a split marker before a large chunk', ['prefix O8K_', 'MARKER' + 'x'.repeat(4096)]],
  ])('retains delivery evidence from %s', (_label, chunks) => {
    registerTerminalBenchPanel('bench-session', true, () => '');
    const session = window.__o8TerminalWriteStats!.sessions['bench-session'];
    session.watchText('O8K_MARKER');
    for (const chunk of chunks) {
      recordTerminalBenchDelivery('bench-session', new TextEncoder().encode(chunk));
    }
    expect(session.textWatch('O8K_MARKER')?.deliveredAt).toEqual(expect.any(Number));
    recordTerminalBenchPaint('bench-session', () => 'visible O8K_MARKER');
    expect(session.textWatch('O8K_MARKER')?.paintedAt).toEqual(expect.any(Number));
  });

  it('does not infer paint from delivery and clears stale evidence on reset', () => {
    registerTerminalBenchPanel('bench-session', true, () => '');
    const session = window.__o8TerminalWriteStats!.sessions['bench-session'];
    session.watchText('O8K_MARKER');
    recordTerminalBenchDelivery('bench-session', new TextEncoder().encode('O8K_MARKER'));
    recordTerminalBenchPaint('bench-session', () => 'unrelated text');
    expect(session.textWatch('O8K_MARKER')?.paintedAt).toBeNull();

    window.__o8TerminalWriteStats!.reset();
    session.watchText('O8K_MARKER');
    recordTerminalBenchDelivery('bench-session', new TextEncoder().encode('new data'));
    expect(session.textWatch('O8K_MARKER')).toEqual({ deliveredAt: null, paintedAt: null });
  });
});
