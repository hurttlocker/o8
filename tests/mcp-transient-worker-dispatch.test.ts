import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleCreateMission } from '@/lib/mcp/operator-handlers/mission';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) {
    const target = tempDirs.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

describe('MCP transient worker dispatch', () => {
  it('accepts an unregistered repo path and carries split-pane provenance', async () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), 'o8-mcp-transient-repo-'));
    tempDirs.push(repoPath);
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({
        ok: true,
        result: {
          missionId: 'mission-mcp-transient',
          packets: [{ id: 'pkt-mcp-transient', title: 'Inspect repo', wave: 1 }],
        },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const result = await handleCreateMission({
      repoPath,
      issues_inline: [{ title: 'Inspect repo' }],
      dispatch: false,
      caller: 'outside session',
    });

    expect(result.isError).not.toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      repoPath,
      launchContext: {
        source: 'mcp',
        presentation: 'split',
        repoContext: 'transient',
        caller: 'outside session',
      },
    });
  });

  it('keeps an in-app orchestrator dispatch in the existing tab presentation', async () => {
    const repoPath = mkdtempSync(path.join(os.tmpdir(), 'o8-mcp-in-app-repo-'));
    tempDirs.push(repoPath);
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({
        ok: true,
        result: { missionId: 'mission-in-app', packets: [{ id: 'pkt-in-app', title: 'Inspect repo', wave: 1 }] },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    await handleCreateMission({
      repoPath,
      issues_inline: [{ title: 'Inspect repo' }],
      dispatch: false,
      orchestratorThreadId: 'thoughts-in-app',
    });

    expect(bodies[0]).toMatchObject({
      launchContext: {
        source: 'desktop',
        presentation: 'tab',
        repoContext: 'registered',
      },
    });
  });
});
