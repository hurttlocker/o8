import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LAUNCH_AGENT_WINDOW_MS,
  launchAgentFailureCount,
  readLaunchAgentStarts,
  recordLaunchAgentStart,
} from './launch-agent-crash-counter';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('LaunchAgent crash counter', () => {
  it('records launchd starts and counts repeated starts as failures', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-launch-agent-counter-'));
    roots.push(dataDir);
    const nowMs = 10 * LAUNCH_AGENT_WINDOW_MS;
    for (let offset = 3; offset >= 0; offset -= 1) {
      recordLaunchAgentStart({ dataDir, parentPid: 1, nowMs: nowMs - offset * 1_000 });
    }
    const starts = readLaunchAgentStarts(dataDir, nowMs);
    expect(starts).toHaveLength(4);
    expect(launchAgentFailureCount(starts, nowMs)).toBe(3);
  });

  it('ignores ordinary child-process starts and expired history', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-launch-agent-counter-'));
    roots.push(dataDir);
    const nowMs = 10 * LAUNCH_AGENT_WINDOW_MS;
    expect(recordLaunchAgentStart({ dataDir, parentPid: 42, nowMs })).toBe(0);
    recordLaunchAgentStart({ dataDir, parentPid: 1, nowMs: nowMs - LAUNCH_AGENT_WINDOW_MS - 1 });
    expect(readLaunchAgentStarts(dataDir, nowMs)).toEqual([]);
  });
});
