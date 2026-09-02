/**
 * Read-only packets must launch as an ENFORCED runtime mode, not a prompt.
 *
 * Real path, end to end: the actual `create_mission` route persists a packet
 * whose launch context is read-only, then the actual `launchRuntimeSurface`
 * chokepoint — the one function every dispatch, retry, rerun, and quota
 * fallback funnels through — resolves that persisted mode and hands it to the
 * runtime as dispatch metadata. The control packet proves a normal write packet
 * is untouched.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { LaunchOptions, RuntimeActionResult } from '@/lib/runtimes/types';

vi.mock('@/lib/runtimes/shared/auth-detect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/auth-detect')>();
  return { ...actual, assertRuntimeDispatchable: vi.fn(async () => {}) };
});

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

const launched: LaunchOptions[] = [];

vi.mock('@/lib/runtimes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes')>();
  return {
    ...actual,
    getRuntime: (runtimeId: string) => (runtimeId === 'claude-code'
      ? {
        id: 'claude-code',
        capabilities: { launch: true },
        async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
          launched.push(opts);
          return {
            ok: true,
            note: 'captured',
            sessionKey: `claude-code-owned:${opts.packetId ?? 'scratch'}`,
            sideEffect: 'none',
          };
        },
      }
      : actual.getRuntime(runtimeId as Parameters<typeof actual.getRuntime>[0])),
  };
});

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-read-only-enforcement-'));
const repoPath = path.join(dataDir, 'repo');
execFileSync('git', ['init', '-q', repoPath]);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const createMissionRoute = await import('@/app/api/orchestrator/create-mission/route');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { launchRuntimeSurface, resolveLaunchWorkMode } = await import('@/lib/runtime/actions');

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function createMission(title: string, issueNumber: number, readOnly: boolean): NextRequest {
  return new NextRequest('http://localhost:3001/api/orchestrator/create-mission', {
    method: 'POST',
    headers: { host: 'localhost:3001' },
    body: JSON.stringify({
      clientMutationId: `read-only-enforcement-${issueNumber}`,
      repoPath,
      requestedRuntime: 'claude-code',
      issues: [{ number: issueNumber, title, body: `Prove ${title}.`, url: '' }],
      launchContext: {
        source: 'cli',
        presentation: 'split',
        repoContext: 'transient',
        caller: 'o8 mission create',
        ...(readOnly ? { workMode: 'read-only' } : {}),
      },
    }),
  });
}

async function persistPacket(title: string, issueNumber: number, readOnly: boolean): Promise<string> {
  const response = await createMissionRoute.POST(createMission(title, issueNumber, readOnly));
  expect(response.status).toBe(201);
  const packet = readOrchestratorControlPlaneState().packets.find((entry) => entry.title === title);
  expect(packet).toBeTruthy();
  return packet!.id;
}

async function launchPacket(packetId: string): Promise<LaunchOptions> {
  const before = launched.length;
  await launchRuntimeSurface({
    runtime: 'claude-code',
    prompt: 'inspect the repository',
    repoPath,
    packetId,
    skipSetup: true,
    isolate: false,
  });
  expect(launched.length).toBe(before + 1);
  return launched[launched.length - 1]!;
}

describe('read-only packets reach the runtime as an enforced mode', () => {
  it('carries the persisted read-only work mode into dispatch metadata', async () => {
    const packetId = await persistPacket('read only enforcement seam', 90_097_001, true);

    const packet = readOrchestratorControlPlaneState().packets.find((entry) => entry.id === packetId);
    expect(packet?.launchContext?.workMode).toBe('read-only');
    // Resolved from persisted state, so a relaunch that supplies no launch
    // context (reset -> dispatch, retry, rerun, quota fallback) still gets it.
    expect(resolveLaunchWorkMode({ runtime: 'claude-code', packetId }))
      .toEqual({ ok: true, workMode: 'read-only' });

    const options = await launchPacket(packetId);
    expect(options.packetId).toBe(packetId);
    expect(options.workMode).toBe('read-only');
  });

  it('leaves a normal write packet in write mode', async () => {
    const packetId = await persistPacket('write packet control seam', 90_097_002, false);

    const packet = readOrchestratorControlPlaneState().packets.find((entry) => entry.id === packetId);
    expect(packet?.launchContext?.workMode).toBeUndefined();
    expect(resolveLaunchWorkMode({ runtime: 'claude-code', packetId }))
      .toEqual({ ok: true, workMode: undefined });

    const options = await launchPacket(packetId);
    expect(options.workMode).toBeUndefined();
  });

  it('never widens a read-only packet when the caller omits the mode', () => {
    expect(resolveLaunchWorkMode({ runtime: 'codex', workMode: 'read-only' }))
      .toEqual({ ok: true, workMode: 'read-only' });
    // A scratch launch carries no packet, so there is no durable mode to fail
    // closed on — it resolves to the caller's (absent) value.
    expect(resolveLaunchWorkMode({ runtime: 'codex' })).toEqual({ ok: true, workMode: undefined });
  });

  it('refuses a real Gemini runtime before launch, worktree creation, or lane mutation', async () => {
    const { geminiRuntime } = await import('@/lib/runtimes/gemini');
    const { listLanes } = await import('@/lib/lane/registry');
    const launchSpy = vi.spyOn(geminiRuntime, 'launch');
    const worktreesBefore = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
    });
    const laneIdsBefore = listLanes().map((lane) => lane.id);
    try {
      const result = await launchRuntimeSurface({
        runtime: 'gemini',
        prompt: 'inspect without changing anything',
        repoPath,
        workMode: 'read-only',
        isolate: true,
        skipSetup: false,
      });
      expect(result).toMatchObject({
        ok: false,
        retryable: false,
        runtime: 'gemini',
        worktree: null,
      });
      expect(result.note).toContain('cannot enforce read-only worker execution');
      expect(launchSpy).not.toHaveBeenCalled();
      expect(execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        encoding: 'utf8',
      })).toBe(worktreesBefore);
      expect(listLanes().map((lane) => lane.id)).toEqual(laneIdsBefore);
    } finally {
      launchSpy.mockRestore();
    }
  });

  it('returns 400 without persistence when the create-mission route requests read-only Gemini', async () => {
    const packetsBefore = readOrchestratorControlPlaneState().packets.map((packet) => packet.id);
    const response = await createMissionRoute.POST(new NextRequest(
      'http://localhost:3001/api/orchestrator/create-mission',
      {
        method: 'POST',
        headers: { host: 'localhost:3001' },
        body: JSON.stringify({
          clientMutationId: 'read-only-gemini-refusal',
          repoPath,
          requestedRuntime: 'gemini',
          issues: [{
            number: 90_097_004,
            title: 'unsupported read only runtime',
            body: 'This mission must not persist.',
            url: '',
          }],
          launchContext: {
            source: 'cli',
            presentation: 'split',
            repoContext: 'transient',
            workMode: 'read-only',
          },
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(readOrchestratorControlPlaneState().packets.map((packet) => packet.id))
      .toEqual(packetsBefore);
  });

  it('returns 400 without persistence for a malformed explicit read-only launchContext', async () => {
    const packetsBefore = readOrchestratorControlPlaneState().packets.map((packet) => packet.id);
    const response = await createMissionRoute.POST(new NextRequest(
      'http://localhost:3001/api/orchestrator/create-mission',
      {
        method: 'POST',
        headers: { host: 'localhost:3001' },
        body: JSON.stringify({
          clientMutationId: 'malformed-read-only-launch-context',
          repoPath,
          requestedRuntime: 'codex',
          issues: [{
            number: 90_097_005,
            title: 'malformed read only launch context',
            body: 'This mission must not persist.',
            url: '',
          }],
          launchContext: { workMode: 'read-only' },
        }),
      },
    ));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(readOrchestratorControlPlaneState().packets.map((packet) => packet.id))
      .toEqual(packetsBefore);
  });
});

describe('an unresolved durable work mode refuses the launch instead of widening it', () => {
  // The hole this closes: falling back to the caller's payload meant a
  // read-only packet whose control-plane read failed launched with FULL WRITE
  // ACCESS — the exact governance promise the feature exists to keep.

  it('refuses when the packet is not in durable state at all', async () => {
    const before = launched.length;
    const result = await launchRuntimeSurface({
      runtime: 'claude-code',
      prompt: 'inspect the repository',
      repoPath,
      packetId: 'pkt-does-not-exist',
      skipSetup: true,
      isolate: false,
    });
    expect(result.ok).toBe(false);
    expect(result.note).toContain('was not found in durable state');
    // Refused BEFORE any side effect: no runtime launch, no worktree.
    expect(launched.length).toBe(before);
    expect(result.worktree).toBeNull();
  });

  it('refuses when resolving the packet launch context throws', async () => {
    const contextModule = await import('@/lib/orchestrator/packet-launch-context');
    const spy = vi.spyOn(contextModule, 'resolvePacketWorkMode')
      .mockImplementation(() => { throw new Error('control plane unreadable'); });
    try {
      const before = launched.length;
      const result = await launchRuntimeSurface({
        runtime: 'claude-code',
        prompt: 'inspect the repository',
        repoPath,
        packetId: 'pkt-throwing',
        skipSetup: true,
        isolate: false,
      });
      expect(result.ok).toBe(false);
      expect(result.note).toContain('control plane unreadable');
      expect(launched.length).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('still launches a recorded packet that carries no launch context (control)', async () => {
    // `launchContext` is optional metadata most write packets never set.
    // Refusing those would brick normal dispatch and prove nothing about
    // read-only, so a FOUND packet without one resolves to write mode.
    const response = await createMissionRoute.POST(new NextRequest(
      'http://localhost:3001/api/orchestrator/create-mission',
      {
        method: 'POST',
        headers: { host: 'localhost:3001' },
        body: JSON.stringify({
          clientMutationId: 'read-only-enforcement-no-context',
          repoPath,
          requestedRuntime: 'claude-code',
          issues: [{
            number: 90_097_003,
            title: 'packet without launch context',
            body: 'No launchContext is supplied.',
            url: '',
          }],
        }),
      },
    ));
    expect(response.status).toBe(201);
    const packet = readOrchestratorControlPlaneState().packets
      .find((entry) => entry.title === 'packet without launch context');
    expect(packet?.launchContext).toBeFalsy();

    const options = await launchPacket(packet!.id);
    expect(options.workMode).toBeUndefined();
  });

  it('still allows a scratch launch that carries no packet id (control)', async () => {
    const before = launched.length;
    const result = await launchRuntimeSurface({
      runtime: 'claude-code',
      prompt: 'inspect the repository',
      repoPath,
      skipSetup: true,
      isolate: false,
    });
    expect(result.ok).toBe(true);
    expect(launched.length).toBe(before + 1);
    expect(launched[launched.length - 1]!.workMode).toBeUndefined();
  });
});
