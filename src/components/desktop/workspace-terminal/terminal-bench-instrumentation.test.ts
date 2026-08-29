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
});
