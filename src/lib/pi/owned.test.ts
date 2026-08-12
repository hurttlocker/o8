import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApproval } from '@/lib/approvals/resolution';
import { getApproval, listApprovals } from '@/lib/approvals/store';
import { getDataDir } from '@/lib/data-dir-migration';
import { isPidAlive } from '@/lib/runtimes/shared/owned-session/helpers';
import {
  archiveOwnedPiSession,
  buildPiPermissionDefaultResponse,
  getOwnedPiFleetAdditions,
  getOwnedPiRuntimeTail,
  handlePiPermissionRequest,
  splitPiRpcJsonlFrames,
} from './owned';

afterEach(() => {
  vi.useRealTimers();
});

describe('Pi RPC framing', () => {
  it('splits only on LF and preserves U+2028 inside JSON strings', () => {
    const payload = Buffer.from('{"type":"message_update","text":"a b"}\n{"type":"agent_end"}\n', 'utf8');
    const result = splitPiRpcJsonlFrames(payload);
    expect(result.carry).toBe('');
    expect(result.lines).toHaveLength(2);
    expect(JSON.parse(result.lines[0])).toEqual({
      type: 'message_update',
      text: 'a b',
    });
  });

  it('carries partial frames across chunks', () => {
    const first = splitPiRpcJsonlFrames(Buffer.from('{"type":"agent_', 'utf8'));
    expect(first.lines).toEqual([]);
    const second = splitPiRpcJsonlFrames(Buffer.from('end"}\n', 'utf8'), first.carry);
    expect(second.lines).toEqual(['{"type":"agent_end"}']);
    expect(second.carry).toBe('');
  });
});

describe('Pi owned-session archival', () => {
  it('removes an archived session from discovery while retaining its transcript', async () => {
    const dirName = `pi-owned-test-archive-${Date.now()}`;
    const surfaceId = `pi-owned:${dirName}`;
    const sessionDir = path.join(process.env.O8_OWNED_PI_ROOT ?? path.join(getDataDir(), 'owned-pi'), dirName);
    const runDir = path.join(sessionDir, 'runs');
    const runId = 'run-archive';
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, `${runId}.jsonl`), '{"type":"agent_end"}\n', 'utf8');
    await writeFile(path.join(runDir, `${runId}.stderr.log`), '', 'utf8');
    await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      sessionDir,
      cwd: process.cwd(),
      repoPath: process.cwd(),
      title: 'Archive lifecycle test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      latestPrompt: 'verify archive',
      latestSummary: 'archive verified',
      recentRuns: [{
        id: runId,
        mode: 'launch',
        prompt: 'verify archive',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        outcome: 'finished',
        stdoutPath: path.join(runDir, `${runId}.jsonl`),
        stderrPath: path.join(runDir, `${runId}.stderr.log`),
      }],
    }), 'utf8');

    expect((await getOwnedPiFleetAdditions()).agents.some((agent) => agent.sessionKey === surfaceId)).toBe(true);
    await expect(archiveOwnedPiSession(surfaceId)).resolves.toMatchObject({ archived: true });
    expect((await getOwnedPiFleetAdditions()).agents.some((agent) => agent.sessionKey === surfaceId)).toBe(false);
    await expect(getOwnedPiRuntimeTail(surfaceId)).resolves.toMatchObject({ surface: { id: surfaceId } });

    await rm(path.join(getDataDir(), 'owned-pi-archive', dirName), { recursive: true, force: true });
  });

  it('does not move a live session until the process is confirmed dead', async () => {
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')",
      'pi-live-archive-test',
    ], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
    });
    const pid = child.pid as number;
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const dirName = `pi-owned-live-archive-${Date.now()}`;
    const surfaceId = `pi-owned:${dirName}`;
    const sessionDir = path.join(process.env.O8_OWNED_PI_ROOT ?? path.join(getDataDir(), 'owned-pi'), dirName);
    const runDir = path.join(sessionDir, 'runs');
    const runId = 'run-live-archive';
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, `${runId}.jsonl`), '', 'utf8');
    await writeFile(path.join(runDir, `${runId}.stderr.log`), '', 'utf8');
    const startedAt = new Date().toISOString();
    await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      sessionDir,
      cwd: process.cwd(),
      repoPath: process.cwd(),
      title: 'Live Pi archive lifecycle test',
      createdAt: startedAt,
      updatedAt: startedAt,
      latestPrompt: 'verify live archive',
      latestSummary: 'verify live archive',
      activeRun: {
        id: runId,
        mode: 'launch',
        prompt: 'verify live archive',
        startedAt,
        outcome: 'running',
        stdoutPath: path.join(runDir, `${runId}.jsonl`),
        stderrPath: path.join(runDir, `${runId}.stderr.log`),
        pid,
      },
      recentRuns: [],
    }), 'utf8');

    await expect(archiveOwnedPiSession(surfaceId)).resolves.toMatchObject({ archived: true });
    await done;
    expect(isPidAlive(pid)).toBe(false);

    const archiveRoot = process.env.O8_OWNED_PI_ARCHIVE_ROOT ?? path.join(getDataDir(), 'owned-pi-archive');
    await rm(path.join(archiveRoot, dirName), { recursive: true, force: true });
  }, 15_000);

  it('kills a persistent idle RPC child even when its turn has no activeRun', async () => {
    const child = spawn(process.execPath, [
      '-e',
      "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')",
      '--', '--mode', 'rpc', 'pi-idle-rpc-archive-test',
    ], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
    });
    const pid = child.pid as number;
    const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const dirName = `pi-owned-idle-rpc-${Date.now()}`;
    const surfaceId = `pi-owned:${dirName}`;
    const sessionDir = path.join(process.env.O8_OWNED_PI_ROOT ?? path.join(getDataDir(), 'owned-pi'), dirName);
    await mkdir(path.join(sessionDir, 'runs'), { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      sessionDir,
      cwd: process.cwd(),
      repoPath: process.cwd(),
      title: 'Idle Pi RPC archive lifecycle test',
      createdAt: timestamp,
      updatedAt: timestamp,
      latestPrompt: 'completed turn',
      latestSummary: 'turn completed',
      rpcPid: pid,
      recentRuns: [],
    }), 'utf8');

    await expect(archiveOwnedPiSession(surfaceId)).resolves.toMatchObject({ archived: true });
    await done;
    expect(isPidAlive(pid)).toBe(false);

    const archiveRoot = process.env.O8_OWNED_PI_ARCHIVE_ROOT ?? path.join(getDataDir(), 'owned-pi-archive');
    await rm(path.join(archiveRoot, dirName), { recursive: true, force: true });
  }, 15_000);

  it('does not signal a persisted RPC pid when its command identity is unavailable', async () => {
    const dirName = `pi-owned-stale-rpc-${Date.now()}`;
    const surfaceId = `pi-owned:${dirName}`;
    const root = process.env.O8_OWNED_PI_ROOT ?? path.join(getDataDir(), 'owned-pi');
    const sessionDir = path.join(root, dirName);
    await mkdir(path.join(sessionDir, 'runs'), { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(path.join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      sessionDir,
      cwd: process.cwd(),
      repoPath: process.cwd(),
      title: 'Stale Pi RPC identity test',
      createdAt: timestamp,
      updatedAt: timestamp,
      latestPrompt: 'completed turn',
      latestSummary: 'turn completed',
      rpcPid: 999_999,
      recentRuns: [],
    }), 'utf8');

    await expect(archiveOwnedPiSession(surfaceId)).resolves.toMatchObject({ archived: true });

    const archiveRoot = process.env.O8_OWNED_PI_ARCHIVE_ROOT ?? path.join(getDataDir(), 'owned-pi-archive');
    await rm(path.join(archiveRoot, dirName), { recursive: true, force: true });
  });
});

describe('Pi permission gate safe defaults', () => {
  it('denies confirm requests', () => {
    expect(buildPiPermissionDefaultResponse({
      type: 'extension_ui_request',
      id: 'req-1',
      kind: 'confirm',
    })).toMatchObject({
      type: 'extension_ui_response',
      id: 'req-1',
      requestId: 'req-1',
      value: false,
      confirmed: false,
    });
  });

  it('cancels select/input requests', () => {
    expect(buildPiPermissionDefaultResponse({
      type: 'extension_ui_request',
      requestId: 'req-2',
      kind: 'select',
    })).toMatchObject({
      type: 'extension_ui_response',
      id: 'req-2',
      requestId: 'req-2',
      cancelled: true,
      value: null,
    });
  });
});

describe('Pi permission-gate bridge', () => {
  function fakeSession(sessionKey: string) {
    return {
      surfaceId: sessionKey,
      title: 'Pi Test Session',
      repoPath: process.cwd(),
      branch: 'test-branch',
    };
  }

  it('creates a real approval and sends an accepted extension_ui_response after operator approval', async () => {
    const sessionKey = `pi-owned:test-approve-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sent: Array<Record<string, unknown>> = [];
    const frame = {
      type: 'extension_ui_request',
      id: 'req-approve',
      kind: 'confirm',
      title: 'Allow Pi to run a shell command?',
      toolName: 'shell',
    };

    const pending = handlePiPermissionRequest(frame, fakeSession(sessionKey), {
      send(command) {
        sent.push(command);
        return true;
      },
    }, { timeoutMs: 2_000, pollMs: 10 });

    const approval = listApprovals({ status: 'pending', sessionKey, projectId: null })[0];
    expect(approval).toBeTruthy();
    expect(approval.runtime).toBe('pi');
    expect(approval.source).toBe('runtime');
    expect(approval.args?.requestId).toBe('req-approve');

    resolveApproval(approval.id, 'approve', 'desktop');
    await pending;

    expect(sent).toEqual([expect.objectContaining({
      type: 'extension_ui_response',
      id: 'req-approve',
      requestId: 'req-approve',
      value: true,
      confirmed: true,
    })]);
  });

  it('times out pending confirm requests with denial and expires the approval card', async () => {
    vi.useFakeTimers();
    const sessionKey = `pi-owned:test-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sent: Array<Record<string, unknown>> = [];
    const frame = {
      type: 'extension_ui_request',
      id: 'req-timeout',
      kind: 'confirm',
      title: 'Allow Pi timeout test?',
    };

    const pending = handlePiPermissionRequest(frame, fakeSession(sessionKey), {
      send(command) {
        sent.push(command);
        return true;
      },
    }, { timeoutMs: 50, pollMs: 10 });

    const approval = listApprovals({ status: 'pending', sessionKey, projectId: null })[0];
    expect(approval).toBeTruthy();

    await vi.advanceTimersByTimeAsync(60);
    await pending;

    expect(sent).toEqual([expect.objectContaining({
      type: 'extension_ui_response',
      id: 'req-timeout',
      requestId: 'req-timeout',
      value: false,
      confirmed: false,
      reason: expect.stringContaining('timed out'),
    })]);
    expect(getApproval(approval.id)?.status).toBe('rejected');
    expect(getApproval(approval.id)?.resolution?.note).toContain('timed out');
  });
});
