import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildToolRegistry, resetToolSpinePortIdentityForTests } from '@/lib/mcp/tool-spine/build';
import { toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';
import { toClaudeServersMap } from '@/lib/mcp/tool-spine/emit-claude';
import { readSharedCheckoutTeam, recordSharedCheckoutMember, reserveSharedCheckoutMember } from '@/lib/orchestrator/shared-checkout-team';

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function callTools(child: ChildProcessWithoutNullStreams) {
  let id = 0;
  const pending = new Map<number, (result: ToolResult) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith('{')) return;
    const message = JSON.parse(line) as { id: number; result: ToolResult };
    pending.get(message.id)?.(message.result);
  });
  return (name: string, args: Record<string, unknown> = {}) => new Promise<ToolResult>((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => {
      pending.delete(callId);
      reject(new Error(`MCP call ${callId} did not settle.`));
    }, 20_000);
    pending.set(callId, (result) => {
      clearTimeout(timer);
      pending.delete(callId);
      resolve(result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call',
      params: { name, arguments: args } })}\n`);
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  vi.unstubAllEnvs();
  resetToolSpinePortIdentityForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generated orchestration MCP owned-root identity', () => {
  it('reads custom-root completion through stdio and retains absent or mismatched workers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-mcp-owned-root-'));
    roots.push(root);
    const repoPath = join(root, 'repo');
    const dataDir = join(root, 'data');
    const ownedRoot = join(root, 'external-owned');
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
      'commit', '-m', 'fixture'], { cwd: repoPath });
    vi.stubEnv('O8_DATA_DIR', dataDir);
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
    vi.stubEnv('O8_BUNDLED_MCP_PATH', '');
    vi.stubEnv('O8_BUNDLED_MCP_DIR', '');
    vi.stubEnv('O8_PACKAGED_APP', '');
    resetToolSpinePortIdentityForTests();
    const parentThreadId = 'thoughts-owned-root';
    const input = { repoPath, parentThreadId, dataDir };
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'Owned',
      clientMutationId: 'owned-root', paths: ['README.md'] });
    await recordSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'Owned',
      clientMutationId: 'owned-root', surfaceId: 'codex-owned:owned-root' });
    const sessionDir = join(ownedRoot, 'owned-root');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, 'session.json');
    const session = { surfaceId: 'codex-owned:owned-root', launchMutationId: 'owned-root',
      cwd: realpathSync(repoPath), repoPath: realpathSync(repoPath), recentRuns: [{ outcome: 'finished' }] };

    const registry = buildToolRegistry(repoPath, { threadId: parentThreadId });
    const servers = toCodexServersMap(registry);
    const config = servers.cortex;
    const claudeConfig = toClaudeServersMap(registry).cortex;
    if (config.type !== 'stdio' || claudeConfig.type !== 'stdio') throw new Error('Expected built-in stdio servers.');
    expect(claudeConfig.env).toEqual(config.env);
    const env = { ...process.env };
    // Codex does not implicitly forward this root. Only the emitted config may supply it.
    delete env.CORTEX_IDE_OWNED_CODEX_ROOT;
    Object.assign(env, config.env, { NODE_OPTIONS: '--conditions=react-server' });
    const child = spawn(config.command, config.args, { cwd: repoPath, env,
      stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    child.stderr.resume();
    const call = callTools(child);
    const finish = { reviewSummary: 'Reviewed scoped fixture.', verification: 'Clean Git checkout verified.' };

    const absent = await call('cortex_finish_shared_team', finish);
    expect(absent.isError).toBe(true);
    expect(readSharedCheckoutTeam(input)?.members).toHaveLength(1);
    writeFileSync(sessionPath, JSON.stringify({ ...session, cwd: root }));
    const mismatch = await call('cortex_finish_shared_team', finish);
    expect(mismatch.isError).toBe(true);
    expect(readSharedCheckoutTeam(input)?.members).toHaveLength(1);
    writeFileSync(sessionPath, JSON.stringify(session));
    const status = await call('cortex_shared_team_status');
    expect(JSON.parse(status.content[0]!.text).memberOutcomes).toMatchObject([{ outcome: 'finished' }]);
    const completed = await call('cortex_finish_shared_team', finish);
    expect(completed.isError).not.toBe(true);
    expect(JSON.parse(completed.content[0]!.text)).toMatchObject({ ok: true });
    expect(readSharedCheckoutTeam(input)).toBeNull();
    expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toEqual(session);

    // A new process sees the durable release rather than holding the old team.
    const reconnect = spawn(config.command, config.args, { cwd: repoPath, env,
      stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(reconnect);
    reconnect.stderr.resume();
    const reconnected = await callTools(reconnect)('cortex_shared_team_status');
    expect(JSON.parse(reconnected.content[0]!.text)).toMatchObject({ team: null });
  }, 60_000);

  it('leaves the default root implicit when no override is configured', () => {
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', '');
    const registry = buildToolRegistry(process.cwd());
    const config = toCodexServersMap(registry).cortex;
    if (config.type !== 'stdio') throw new Error('Expected built-in stdio server.');
    expect(config.env).not.toHaveProperty('CORTEX_IDE_OWNED_CODEX_ROOT');
  });
});
