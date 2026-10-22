import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildToolRegistry, resetToolSpinePortIdentityForTests } from '@/lib/mcp/tool-spine/build';
import { toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';
import { toClaudeServersMap } from '@/lib/mcp/tool-spine/emit-claude';
import { readSharedCheckoutTeam, recordSharedCheckoutMember, reserveSharedCheckoutMember } from '@/lib/orchestrator/shared-checkout-team';

type ToolResult = { isError?: boolean; content: Array<{ text: string }>; tools?: Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }> };
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
  return (name: string, args: Record<string, unknown> = {}, method = 'tools/call') => new Promise<ToolResult>((resolve, reject) => {
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
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: callId, method,
      params: method === 'tools/list' ? {} : { name, arguments: args } })}\n`);
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
  it('reconciles exact independent edits through stdio, preserves provenance, and refuses stale or incomplete review', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-mcp-team-review-'));
    roots.push(root);
    const repoPath = join(root, 'repo');
    const dataDir = join(root, 'data');
    const ownedRoot = join(root, 'owned');
    mkdirSync(repoPath);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
    git('add', '.');
    git('-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture');
    writeFileSync(join(repoPath, 'existing.txt'), 'before\n');
    vi.stubEnv('O8_DATA_DIR', dataDir);
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
    vi.stubEnv('O8_BUNDLED_MCP_PATH', '');
    vi.stubEnv('O8_BUNDLED_MCP_DIR', '');
    vi.stubEnv('O8_PACKAGED_APP', '');
    resetToolSpinePortIdentityForTests();
    const parentThreadId = 'thoughts-reconcile';
    const input = { repoPath, parentThreadId, dataDir };
    for (const id of ['first', 'second']) {
      await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: id,
        clientMutationId: id, paths: [`${id}.txt`] });
      await recordSharedCheckoutMember({ ...input, runtime: 'codex', taskName: id,
        clientMutationId: id, surfaceId: `codex-owned:${id}` });
      mkdirSync(join(ownedRoot, id), { recursive: true });
      writeFileSync(join(ownedRoot, id, 'session.json'), JSON.stringify({ surfaceId: `codex-owned:${id}`,
        launchMutationId: id, cwd: realpathSync(repoPath), repoPath: realpathSync(repoPath),
        recentRuns: [{ id: `${id}-run`, outcome: 'finished' }] }));
    }
    const original = readSharedCheckoutTeam(input)!;
    writeFileSync(join(repoPath, 'existing.txt'), 'independent edit\n');
    writeFileSync(join(repoPath, 'outside.txt'), 'independent addition\n');
    writeFileSync(join(repoPath, 'committed.txt'), 'independent commit\n');
    git('add', 'committed.txt');
    git('-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'Independent');

    const start = (owner = parentThreadId) => {
      const config = toCodexServersMap(buildToolRegistry(repoPath, { threadId: owner })).cortex;
      if (config.type !== 'stdio') throw new Error('Expected stdio.');
      const child = spawn(config.command, config.args, { cwd: repoPath,
        env: { ...process.env, ...config.env, NODE_OPTIONS: '--conditions=react-server' }, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      child.stderr.resume();
      return callTools(child);
    };
    const call = start();
    const listed = await call('', {}, 'tools/list');
    const launchTool = listed.tools!.find(tool => tool.name === 'cortex_launch_agent')!;
    expect(launchTool.description).toContain('Shared workers share');
    expect(launchTool.inputSchema.properties.checkoutMode.description).toContain('Shared mode');
    expect(launchTool.inputSchema.properties.assignedPaths.description).toContain('Shared mode');
    const finish = { reviewSummary: 'Both read-only workers settled.', verification: 'Reviewed exact Git delta.' };
    expect((await call('cortex_finish_shared_team', finish)).isError).toBe(true);
    const status = JSON.parse((await call('cortex_shared_team_status')).content[0]!.text);
    expect(status.review).toMatchObject({ head: git('rev-parse', 'HEAD'),
      paths: ['committed.txt', 'existing.txt', 'outside.txt'] });
    const review = { reviewId: status.review.id, reviewedHead: status.review.head,
      acknowledgedPaths: status.review.paths, reviewSummary: 'Reviewed independent edits; preserve them without committing.' };
    expect((await start('thoughts-unrelated')('cortex_reconcile_shared_team', review)).isError).toBe(true);
    expect((await call('cortex_reconcile_shared_team', { ...review, acknowledgedPaths: ['outside.txt'] })).isError).toBe(true);
    const sessionFile = join(ownedRoot, 'first', 'session.json');
    const session = readFileSync(sessionFile, 'utf8');
    writeFileSync(sessionFile, JSON.stringify({ ...JSON.parse(session), activeRun: { pid: process.pid, outcome: 'running' } }));
    expect((await call('cortex_reconcile_shared_team', review)).isError).toBe(true);
    writeFileSync(sessionFile, session);
    writeFileSync(join(repoPath, 'outside.txt'), 'changed after review\n');
    expect((await call('cortex_reconcile_shared_team', review)).isError).toBe(true);
    const latestReview = async () => {
      const latest = JSON.parse((await call('cortex_shared_team_status')).content[0]!.text).review;
      return { ...review, reviewId: latest.id, reviewedHead: latest.head, acknowledgedPaths: latest.paths };
    };
    const accepted = await latestReview();
    expect((await call('cortex_reconcile_shared_team', accepted)).isError).not.toBe(true);
    expect((await call('cortex_reconcile_shared_team', accepted)).isError).not.toBe(true);
    expect(readSharedCheckoutTeam(input)?.reconciliations).toHaveLength(1);
    expect(readSharedCheckoutTeam(input)).toMatchObject({ baseHead: original.baseHead,
      initialChangedFingerprints: original.initialChangedFingerprints, members: original.members });

    // A previously clean tracked file can have a staged-only change while its
    // worktree matches HEAD. It must invalidate review and appear in the paths.
    writeFileSync(join(repoPath, 'README.md'), 'staged independent change\n');
    git('add', 'README.md');
    writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
    expect((await call('cortex_finish_shared_team', finish)).isError).toBe(true);
    expect((await latestReview()).acknowledgedPaths).toContain('README.md');

    // Worktree contents stay the same while the staged version changes: still stale.
    git('add', 'outside.txt');
    expect((await start()('cortex_finish_shared_team', finish)).isError).toBe(true);
    expect((await call('cortex_reconcile_shared_team', await latestReview())).isError).not.toBe(true);
    writeFileSync(join(repoPath, 'first.txt'), 'uncommitted worker work\n');
    expect((await call('cortex_reconcile_shared_team', await latestReview())).isError).toBe(true);
    git('add', 'first.txt');
    git('-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'Reviewed worker result');
    expect((await call('cortex_reconcile_shared_team', accepted)).isError).toBe(true);
    expect((await call('cortex_reconcile_shared_team', await latestReview())).isError).not.toBe(true);
    const before = { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'),
      diff: git('diff', '--binary', 'HEAD'), source: readFileSync(join(repoPath, 'existing.txt'), 'utf8') };
    // Nested content cannot be approved from a constant Git directory marker.
    mkdirSync(join(repoPath, 'nested'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: join(repoPath, 'nested') });
    execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
      'commit', '--allow-empty', '-m', 'nested'], { cwd: join(repoPath, 'nested') });
    git('add', 'nested');
    expect((await call('cortex_reconcile_shared_team', await latestReview())).isError).toBe(true);
    // Remove only the test-created nested repository from this disposable fixture.
    git('rm', '--cached', '-f', 'nested');
    rmSync(join(repoPath, 'nested'), { recursive: true });
    if (process.platform !== 'win32') {
      symlinkSync('missing-one', join(repoPath, 'link'));
      const linked = await latestReview();
      expect((await call('cortex_reconcile_shared_team', linked)).isError).not.toBe(true);
      unlinkSync(join(repoPath, 'link'));
      symlinkSync('missing-two', join(repoPath, 'link'));
      expect((await call('cortex_finish_shared_team', finish)).isError).toBe(true);
      expect((await call('cortex_reconcile_shared_team', linked)).isError).toBe(true);
      unlinkSync(join(repoPath, 'link'));
    }
    const finished = await start()('cortex_finish_shared_team', finish);
    expect(finished.isError).not.toBe(true);
    expect(JSON.parse(finished.content[0]!.text).note).toContain('Shared team review');
    expect(readSharedCheckoutTeam(input)).toBeNull();
    expect({ head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'),
      diff: git('diff', '--binary', 'HEAD'), source: readFileSync(join(repoPath, 'existing.txt'), 'utf8') }).toEqual(before);
    const archive = join(dataDir, 'shared-checkout-teams', 'archive');
    const receipt = JSON.parse(readFileSync(join(archive, readdirSync(archive)[0]!), 'utf8'));
    expect(receipt.baseHead).toBe(original.baseHead);
    expect(receipt.reconciliations).toHaveLength(process.platform === 'win32' ? 3 : 4);
    expect(JSON.parse((await start()('cortex_shared_team_status')).content[0]!.text)).toEqual({
      team: null, note: 'No Shared workers have been launched from this chat.',
    });
  }, 90_000);

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
