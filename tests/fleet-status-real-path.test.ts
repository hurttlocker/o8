import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetSnapshot } from '@/lib/fleet/types';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const previousClaudeHome = vi.hoisted(() => {
  const previous = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = `${process.env.CORTEX_IDE_DATA_DIR}/fleet-provider-home`;
  return previous;
});

vi.mock('@/lib/runtimes', async () => {
  const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');
  return { getAllRuntimes: () => [claudeCodeRuntime] };
});

vi.mock('@/lib/runtimes/claude-code-process-probe', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/claude-code-process-probe')>(),
  probeLiveClaudeProcesses: async () => ({ processes: [], probed: true }),
}));

vi.mock('@/lib/lane/sweep-orphan-sessions', () => ({
  sweepOrphanedOwnedSessions: async () => {},
}));

const { GET } = await import('@/app/api/runtime/inventory/route');
const { invalidateRuntimeInventoryCache } = await import('@/lib/runtime/inventory');
const { listIdeRuntimeTabs } = await import('@/lib/runtime/ide-session-registry');
const { getOwnedClaudeCodeFleetAdditions } = await import('@/lib/claude-code/owned');
const { claudeCodeRuntime } = await import('@/lib/runtimes/claude-code');

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const ownedRoot = process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT!;
const repoPath = path.join(dataDir, 'fleet-repo');
const stateRoot = path.join(dataDir, 'terminal-states');
const surfaceId = 'claude-code-owned:fleet-session';
const now = Date.parse('2026-09-09T12:00:00.000Z');
const activityAt = now - 5_000;

function saveTab(scope: string, savedAt: unknown = new Date(now).toISOString(), sessionKey = surfaceId) {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(path.join(stateRoot, `${scope}.json`), JSON.stringify({
    activeTabId: 'fleet-tab',
    savedAt,
    tabs: [{
      id: 'fleet-tab', kind: 'chat', chatRuntime: 'claude-code',
      chatSessionKey: sessionKey, label: 'Review session', repoPath,
      supervisorStatus: 'reviewing',
    }],
  }));
}

function saveOwnedSession() {
  const sessionDir = path.join(ownedRoot, 'fleet-session');
  mkdirSync(sessionDir, { recursive: true });
  const session: OwnedSessionRecord = {
    surfaceId, sessionDir, cwd: repoPath, repoPath,
    title: 'Review session', threadId: 'fleet-provider-session',
    createdAt: new Date(activityAt).toISOString(),
    updatedAt: new Date(activityAt).toISOString(),
    latestPrompt: 'Review pending changes', latestSummary: 'Review complete',
    recentRuns: [],
  };
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
  return sessionDir;
}

async function inventory(): Promise<FleetSnapshot> {
  invalidateRuntimeInventoryCache();
  const response = await GET(new NextRequest('http://localhost/api/runtime/inventory?fresh=1'));
  expect(response.status).toBe(200);
  return response.json();
}

async function callFleetStatus() {
  const server = createServer((request, response) => {
    if (request.url !== '/api/runtime/inventory?fresh=1') {
      response.writeHead(404).end();
      return;
    }
    void GET(new NextRequest(`http://localhost${request.url}`)).then(async (result) => {
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(await result.text());
    }).catch(() => response.writeHead(500).end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a port.');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/mcp/cortex-mcp-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_API_BASE: `http://127.0.0.1:${address.port}`,
      O8_DATA_DIR: dataDir,
      WS_TOKEN: 'fleet-fixture-token',
      O8_MCP_NODE22_CHECKED: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exited = once(child, 'exit');
  try {
    return await new Promise<{ agentCount: number; agents: Array<{ lastActive: string }> }>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`Fleet MCP timed out: ${stderr}`)), 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Fleet MCP exited: ${stderr}`)); });
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.startsWith('{')) continue;
          try {
            const message = JSON.parse(line);
            if (message.id !== 1) continue;
            clearTimeout(timer);
            if (message.error || message.result?.isError) reject(new Error(line));
            else resolve(JSON.parse(message.result.content[0].text));
          } catch (error) { clearTimeout(timer); reject(error); }
        }
      });
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cortex_fleet_status', arguments: { fresh: true } },
      })}\n`);
    });
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    await exited;
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  mkdirSync(repoPath, { recursive: true });
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(ownedRoot, { recursive: true, force: true });
  invalidateRuntimeInventoryCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (previousClaudeHome === undefined) delete process.env.CLAUDE_HOME;
  else process.env.CLAUDE_HOME = previousClaudeHome;
});

describe('fleet status from persisted owned sessions', () => {
  it('keeps one live row after repeated IDE registration through the MCP entry point', async () => {
    saveOwnedSession();
    saveTab('tile-root');
    saveTab('repo-fleet');

    const result = await callFleetStatus();

    expect(result.agentCount).toBe(1);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].lastActive).toBe('5s ago');
    expect(listIdeRuntimeTabs().map((tab) => tab.sessionKey)).toEqual([surfaceId]);
  });

  it('carries the persisted activity instant through owned discovery to the inventory route', async () => {
    const sessionDir = saveOwnedSession();
    const before = readFileSync(path.join(sessionDir, 'session.json'), 'utf8');
    const owned = await getOwnedClaudeCodeFleetAdditions({ fresh: true });
    expect(owned.agents[0].lastActivityAt).toBe(activityAt);
    const sessions = await claudeCodeRuntime.discoverSessions({ fresh: true });
    expect(sessions[0].lastActivityAt.getTime()).toBe(activityAt);
    const result = await inventory();
    expect(result.agents[0]).toMatchObject({ lastActivityAt: activityAt, lastEventAt: '5s ago' });
    expect(readFileSync(path.join(sessionDir, 'session.json'), 'utf8')).toBe(before);
  });

  it.each([undefined, 'bad-date'])('uses an unknown label for a missing or invalid saved tab timestamp (%s)', async (savedAt) => {
    saveTab('tile-root', savedAt === undefined ? null : savedAt, 'unavailable-session');
    const result = await inventory();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].lastEventAt).toBe('unknown');
    expect(result.agents[0].lastActivityAt).toBeNull();
  });

  it('preserves distinct session keys even when their labels and repository match', async () => {
    saveTab('tile-root', new Date(now).toISOString(), 'session-one');
    saveTab('repo-fleet', new Date(now).toISOString(), 'session-two');
    const result = await inventory();
    expect(result.agents.map((agent) => agent.sessionKey).sort()).toEqual([
      'claude-code:session-one', 'claude-code:session-two',
    ]);
  });
});
