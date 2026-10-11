import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { createPiSdkSession } from '@/lib/pi/sdk/session';
import type { PiToolCall } from '@/lib/pi/sdk/tools';
import { getDataDir } from '@/lib/data-dir-migration';
import { piCommandCleanupUnconfirmed } from '@/lib/pi/sdk/command';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));
const receipts = vi.hoisted(() => [] as string[]);
const supervisors = vi.hoisted(() => [] as number[]);
vi.mock('node:child_process', async importOriginal => {
  const cp = await importOriginal<typeof import('node:child_process')>();
  return { ...cp, spawn: ((...args: Parameters<typeof cp.spawn>) => {
    const child = cp.spawn(...args);
    if (args[1]?.[0] === 'supervise') {
      supervisors.push(child.pid!);
      const index = receipts.push('') - 1;
      (child.stdio[3] as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => { receipts[index] += chunk.toString('utf8'); });
    }
    return child;
  }) as typeof cp.spawn };
});

const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions',
  provider: 'o8-managed', baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'],
  contextWindow: 16000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
// The ordering case also commits an approved write through the native helper.
beforeAll(() => { helperPath = buildPiWriteHelper(); }, 600_000);
const roots: string[] = [];
const clients: Awaited<ReturnType<typeof createPiSdkSession>>[] = [];
afterEach(async () => {
  receipts.length = 0;
  supervisors.length = 0;
  vi.unstubAllEnvs();
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  await rm(join(getDataDir(), 'policies.json'), { force: true });
  (await import('@/lib/approvals/policies')).refreshPolicyRules();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'o8-pi-command-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  return { root, workspace, stateDir: join(root, 'state') };
}
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, stopReason, model: model.id, api: model.api,
    provider: model.provider, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0,
      cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function events(answer: AssistantMessage): AssistantMessageEvent[] {
  return [{ type: 'start', partial: answer },
    ...(answer.content[0]?.type === 'text' ? [{ type: 'text_delta' as const, contentIndex: 0, delta: answer.content[0].text, partial: answer }] : []),
    { type: 'done', reason: answer.stopReason as 'stop' | 'toolUse', message: answer }];
}
type ToolCalls = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>[];
/** First model call asks for the tools; the second sees their results and ends the run. */
function scripted(calls: ToolCalls, results: string[] = []) {
  let turn = 0;
  return async function* (context: { messages: unknown[] }) {
    if (++turn === 1) { yield* events(message(calls, 'toolUse')); return; }
    for (const entry of context.messages as { role: string; content?: { type: string; text?: string }[] }[]) {
      if (entry.role === 'toolResult') results.push((entry.content ?? []).map(part => part.text ?? '').join(''));
    }
    yield* events(message([{ type: 'text', text: 'Done' }]));
  };
}
function command(id: string, text: string): ToolCalls[number] {
  return { type: 'toolCall', id, name: 'run_command', arguments: { command: text } };
}
async function client(options: Parameters<typeof createPiSdkSession>[0]) {
  const session = await createPiSdkSession(options); clients.push(session); return session;
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}
const TREE_PIDS = ['group.pid', 'job.pid', 'hard.pid'];
async function pids(dir: string, names = TREE_PIDS) {
  return Promise.all(names.map(async name => Number((await readFile(join(dir, name), 'utf8')).trim())));
}
function pgid(pid: number) { return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); }
async function allEnded(dir: string, names = TREE_PIDS) {
  for (const pid of await pids(dir, names)) await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 8_000 });
}
// Three processes the tree must end: a background child in the command's group,
// a child in its own group, and a child in its own group that ignores TERM and
// whose parent dies on TERM, so it is reparented during cleanup.
const TREE = `sleep 30 & echo $! > group.pid; perl -e 'setpgrp(0,0); sleep 30' & echo $! > job.pid; `
  + `sh -c 'perl -e "\\$SIG{TERM}=q(IGNORE); setpgrp(0,0); sleep 30" & echo $! > hard.pid; wait' & sleep 0.3`;

const supervisorIt = it.runIf(process.platform === 'linux' || process.platform === 'darwin');
let helperPath = '';

describe('Pi governed command tool through the real worker', () => {
  // The parent stays alive briefly so its fork event can be handled, then exits.
  // The child closes the output pipes, ignores TERM and leaves the process group.
  const MAC_ESCAPE = `perl -MPOSIX -e '$p=fork(); die unless defined $p; if ($p) { select undef, undef, undef, 0.15; exit; } $SIG{TERM}=q(IGNORE); $sid=POSIX::setsid(); open(STDOUT, q(>), q(/dev/null)); open(STDERR, q(>), q(/dev/null)); open(my $f, q(>), q(hard.pid)); print $f $$; close $f; open($f, q(>), q(hard.sid)); print $f $sid; close $f; select undef, undef, undef, 0.3; open($f, q(>), q(hard.ppid)); print $f getppid(); close $f; sleep 30'; while [ ! -s hard.ppid ]; do sleep 0.02; done`;
  it.runIf(process.platform === 'darwin').each(['exit', 'timeout', 'Stop'] as const)(
    'confirms macOS orphan teardown at %s through the real command tool', async mode => {
      const paths = await fixture(); const results: string[] = [];
      const session = await client({ ...paths, model, approve: async () => true, commandTimeoutMs: mode === 'timeout' ? 2_000 : 120_000,
        transport: scripted([command('mac-escape', `${MAC_ESCAPE}; touch started; ${mode === 'exit' ? 'true' : 'sleep 30'}`)], results) });
      const run = session.prompt('Run an orphaned child');
      let hard = 0;
      try {
        await vi.waitFor(() => readFile(join(paths.workspace, 'started')), { timeout: 10_000, interval: 50 });
        [hard] = await pids(paths.workspace, ['hard.pid']);
        expect(Number(await readFile(join(paths.workspace, 'hard.sid'), 'utf8'))).toBe(hard);
        expect(Number(await readFile(join(paths.workspace, 'hard.ppid'), 'utf8'))).toBe(1);
        if (mode === 'Stop') await session.abort();
        await run;
        if (mode !== 'Stop') expect(results[0]).toContain(mode === 'exit' ? 'Exit code 0' : 'stopped after 2 seconds');
        expect(receipts).toHaveLength(1);
        expect(JSON.parse(receipts[0])).toMatchObject({ confirmed: true });
        await vi.waitFor(() => expect(alive(hard)).toBe(false), { timeout: 2_000 });
      } finally {
        await session.abort(); await run;
        if (hard && alive(hard)) process.kill(hard, 'SIGKILL');
      }
    }, 30000);

  it('runs an approved command in the workspace with a cleaned environment', async () => {
    const paths = await fixture(); const results: string[] = []; const approvals: PiToolCall[] = [];
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-synthetic-secret');
    vi.stubEnv('O8_SYNTHETIC_HOST_ONLY', 'synthetic-host-value');
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/synthetic-agent.sock');
    const session = await client({ ...paths, model, approve: async call => { approvals.push(call); return true; },
      transport: scripted([command('env', 'pwd; env')], results) });
    expect(session.tools).toEqual(['read_file', 'write_file', 'run_command']);
    expect(await session.prompt('Show the environment')).toMatchObject({ text: 'Done', stopReason: 'stop' });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ name: 'run_command', args: { command: 'pwd; env' } });
    expect(results[0]).toContain('Exit code 0');
    expect(results[0]).toContain(`\n${paths.workspace}\n`);
    for (const secret of ['sk-or-synthetic-secret', 'synthetic-host-value', 'synthetic-agent.sock', 'CORTEX_IDE_DATA_DIR']) {
      expect(results[0]).not.toContain(secret);
    }
  }, 20000);

  it('never starts a denied command or a policy-blocked command', async () => {
    const paths = await fixture(); const results: string[] = []; const asked: string[] = [];
    const session = await client({ ...paths, model,
      approve: async call => { asked.push(String(call.args.command)); return false; },
      transport: scripted([command('denied', 'echo ran > denied.txt'), command('blocked', 'sudo touch blocked.txt')], results) });
    await session.prompt('Try both');
    expect(asked).toEqual(['echo ran > denied.txt']);
    expect(await readdir(paths.workspace)).toEqual([]);
    expect(results.join('\n')).not.toContain('Exit code');
  }, 20000);

  it('runs without approval when an operator rule allows commands in this workspace', async () => {
    const paths = await fixture(); let asked = 0;
    await writeFile(join(getDataDir(), 'policies.json'), JSON.stringify([
      { id: 'mutation-shell', requiresApproval: false, workspacePath: paths.workspace }]));
    (await import('@/lib/approvals/policies')).refreshPolicyRules();
    const session = await client({ ...paths, model, approve: async () => { asked++; return false; },
      transport: scripted([command('allowed', 'echo ran > allowed.txt')]) });
    await session.prompt('Run it');
    expect(asked).toBe(0);
    expect(await readFile(join(paths.workspace, 'allowed.txt'), 'utf8')).toBe('ran\n');
  }, 20000);

  it('ends the whole process tree at the timeout', async () => {
    const paths = await fixture(); const results: string[] = [];
    const session = await client({ ...paths, model, approve: async () => true, commandTimeoutMs: 1_000,
      transport: scripted([command('slow', `${TREE}; sleep 30`)], results) });
    const started = Date.now();
    await session.prompt('Run a slow command');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(results[0]).toContain('stopped after 1 second');
    await allEnded(paths.workspace);
  }, 20000);

  it('ends the whole process tree when the output cap is reached', async () => {
    const paths = await fixture(); const results: string[] = [];
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('loud', `${TREE}; while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done`)], results) });
    await session.prompt('Run a loud command');
    expect(results[0]).toContain('more than 50000 bytes of output');
    expect(Buffer.byteLength(results[0])).toBeLessThan(52_000);
    await allEnded(paths.workspace);
  }, 20000);

  it('ends the whole process tree on Stop', async () => {
    const paths = await fixture();
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('stop', `${TREE}; touch started; sleep 30`)]) });
    const run = session.prompt('Run until stopped');
    await vi.waitFor(() => readFile(join(paths.workspace, 'started')), { timeout: 10_000, interval: 50 });
    const [group, job, hard] = await pids(paths.workspace);
    expect(new Set([pgid(group), pgid(job), pgid(hard)]).size).toBe(3);
    await session.abort(); await run;
    await allEnded(paths.workspace);
  }, 20000);

  it('ends background processes before a write from the same turn starts', async () => {
    const paths = await fixture(); const atWrite: { ran: boolean; groupAlive: boolean; jobAlive: boolean }[] = [];
    const session = await client({ ...paths, model,
      approve: async call => {
        if (call.name === 'write_file') {
          const [group, job, hard] = await pids(paths.workspace);
          atWrite.push({ ran: (await readdir(paths.workspace)).includes('ran.txt'), groupAlive: alive(group), jobAlive: alive(job) || alive(hard) });
        }
        return true;
      },
      // Pi runs tool calls from one message in parallel unless the host serializes them.
      transport: scripted([command('background', `${TREE}; sleep 0.5; echo done > ran.txt`),
        { type: 'toolCall', id: 'write', name: 'write_file', arguments: { path: 'note.txt', content: 'written' } }]) });
    await session.prompt('Run then write');
    expect(atWrite).toEqual([{ ran: true, groupAlive: false, jobAlive: false }]);
    expect(await readFile(join(paths.workspace, 'note.txt'), 'utf8')).toBe('written');
  }, 20000);

  it('stops output that fills the cap exactly and then continues', async () => {
    const paths = await fixture(); const results: string[] = [];
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('exact', 'head -c 50000 /dev/zero | tr "\\000" x; sleep 0.3; echo more >&2; sleep 30')], results) });
    const started = Date.now();
    await session.prompt('Fill the cap');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(results[0]).toContain('more than 50000 bytes of output');
  }, 20000);

  it.each(['approve', 'reject'] as const)('uses the persisted inbox to %s an exact command', async action => {
    const paths = await fixture();
    const { listApprovals } = await import('@/lib/approvals/store');
    const { resolveApproval } = await import('@/lib/approvals/resolution');
    const session = await client({ ...paths, model, transport: scripted([command('inbox', 'echo ran > inbox.txt')]) });
    const run = session.prompt('Run through the inbox');
    let approval!: ReturnType<typeof listApprovals>[number];
    await vi.waitFor(() => {
      const rows = listApprovals({ status: 'pending', projectId: null, sessionKey: session.surfaceId });
      expect(rows).toHaveLength(1); approval = rows[0];
    }, { timeout: 10000, interval: 20 });
    expect(approval).toMatchObject({ toolName: 'run_command', command: 'echo ran > inbox.txt', title: 'Run a command',
      editable: false, args: { command: 'echo ran > inbox.txt' } });
    expect(await readdir(paths.workspace)).toEqual([]);
    resolveApproval(approval.id, action, 'desktop'); await run;
    expect(await readdir(paths.workspace)).toEqual(action === 'approve' ? ['inbox.txt'] : []);
  }, 30000);

  it('keeps a write from another session on the same workspace out of a running command', async () => {
    const paths = await fixture(); const results: string[] = [];
    const runner = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('watch', 'touch started; for i in 1 2 3 4 5 6 7 8 9 10; do [ -e note.txt ] && echo S""EEN; sleep 0.1; done; echo finished')], results) });
    const writer = await client({ ...paths, stateDir: join(paths.root, 'state-writer'), model, approve: async () => true,
      transport: scripted([{ type: 'toolCall', id: 'write', name: 'write_file', arguments: { path: 'note.txt', content: 'written' } }]) });
    const running = runner.prompt('Watch the workspace');
    await vi.waitFor(() => readFile(join(paths.workspace, 'started')), { timeout: 10_000, interval: 20 });
    await Promise.all([running, writer.prompt('Write a note')]);
    expect(results[0]).toContain('finished');
    expect(results[0]).not.toContain('SEEN');
    expect(await readFile(join(paths.workspace, 'note.txt'), 'utf8')).toBe('written');
  }, 30000);

  it('refuses to start when the workspace is replaced by a symlink after approval', async () => {
    const paths = await fixture(); const results: string[] = []; const outside = join(paths.root, 'outside');
    await mkdir(outside);
    const session = await client({ ...paths, model, transport: scripted([command('swap', 'echo ran > ran.txt')], results),
      approve: async () => {
        await rename(paths.workspace, join(paths.root, 'moved'));
        await symlink(outside, paths.workspace);
        return true;
      } });
    await session.prompt('Run after the swap');
    expect(results[0]).toContain('Exit code 126');
    expect(results[0]).toContain('The workspace changed before the command started.');
    expect(await readdir(outside)).toEqual([]);
  }, 20000);

  it('lets Stop end a write that is waiting behind another session\'s command', async () => {
    const paths = await fixture();
    const runner = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('long', 'touch started; sleep 30')]) });
    let approved!: () => void; const writeApproved = new Promise<void>(resolve => { approved = resolve; });
    const writer = await client({ ...paths, stateDir: join(paths.root, 'state-writer'), model,
      approve: async () => { approved(); return true; },
      transport: scripted([{ type: 'toolCall', id: 'write', name: 'write_file', arguments: { path: 'note.txt', content: 'queued' } }]) });
    const running = runner.prompt('Run a long command');
    await vi.waitFor(() => readFile(join(paths.workspace, 'started')), { timeout: 10_000, interval: 20 });
    const writing = writer.prompt('Write behind it');
    await writeApproved;
    const stopped = Date.now();
    await writer.abort(); await writing;
    expect(Date.now() - stopped).toBeLessThan(3_000);
    expect(await readdir(paths.workspace)).toEqual(['started']);
    await runner.abort(); await running;
  }, 30000);

  it('returns all output written just before a quick exit', async () => {
    const paths = await fixture(); const results: string[] = [];
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('burst', 'head -c 40000 /dev/zero | tr "\\000" y; echo END')], results) });
    await session.prompt('Write a burst');
    expect(results[0]).toContain('Exit code 0');
    expect(results[0]).toContain(`${'y'.repeat(40000)}END`);
  }, 20000);

  // A TERM-ignoring child that starts a new session and is orphaned at once:
  // its parent exits before any read could see it. The command waits until the
  // child is ready and records its session id before going on.
  const ESCAPE = `sh -c 'perl -MPOSIX -e "\\$SIG{TERM}=q(IGNORE); POSIX::setsid(); open(my \\$f, q(>), q(ready)); close \\$f; sleep 30" & echo $! > hard.pid'; `
    + 'while [ ! -e ready ]; do sleep 0.05; done; ps -o sid= -p "$(cat hard.pid)" > hard.sid';
  async function expectEndedNow(dir: string) {
    const [hard] = await pids(dir, ['hard.pid']);
    expect(Number((await readFile(join(dir, 'hard.sid'), 'utf8')).trim())).toBe(hard);
    // The supervisor reaps every descendant before its receipt, so none is left when the call returns.
    expect(alive(hard)).toBe(false);
  }

  it.runIf(process.platform === 'linux').each([
    ['a normal exit', `${ESCAPE}; sleep 0.3`, {}, 'Exit code 0'],
    ['the timeout', `${ESCAPE}; sleep 30`, { commandTimeoutMs: 2_000 }, 'stopped after 2 seconds'],
  ] as const)('ends an orphaned child in its own session at %s', async (_case, text, limits, status) => {
    const paths = await fixture(); const results: string[] = [];
    const session = await client({ ...paths, model, approve: async () => true, ...limits, transport: scripted([command('escape', text)], results) });
    await session.prompt('Run an escaping child');
    expect(results[0]).toContain(status);
    await expectEndedNow(paths.workspace);
  }, 30000);

  it.runIf(process.platform === 'linux')('ends an orphaned child in its own session on Stop', async () => {
    const paths = await fixture();
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('escape-stop', `${ESCAPE}; touch started; sleep 30`)]) });
    const run = session.prompt('Run until stopped');
    await vi.waitFor(() => readFile(join(paths.workspace, 'started')), { timeout: 10_000, interval: 50 });
    await session.abort(); await run;
    await expectEndedNow(paths.workspace);
  }, 30000);

  supervisorIt('ends the command tree when the host process dies', async () => {
    const paths = await fixture();
    // A stand-in host: a shell that starts the supervisor, then is killed.
    const host = spawn('/bin/sh', ['-c', '"$0" supervise $$ /bin/sh -c "sleep 30 & echo \\$! > bg.pid; sleep 30" 3>/dev/null & echo $! > supervisor.pid; wait',
      helperPath], { cwd: paths.workspace, stdio: 'ignore' });
    await vi.waitFor(() => readFile(join(paths.workspace, 'bg.pid')), { timeout: 10_000, interval: 50 });
    const [supervisor, background] = await pids(paths.workspace, ['supervisor.pid', 'bg.pid']);
    expect(alive(background)).toBe(true);
    host.kill('SIGKILL');
    await vi.waitFor(() => expect([alive(supervisor), alive(background)]).toEqual([false, false]), { timeout: 10_000 });
  }, 30000);

  supervisorIt('refuses to start the command when its parent is not the expected host', async () => {
    const paths = await fixture();
    const run = spawnSync(helperPath, ['supervise', '1', '/bin/sh', '-c', 'touch ran'],
      { cwd: paths.workspace, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8' });
    expect(run.status).toBe(125);
    expect(JSON.parse(String(run.output[3]).trim())).toEqual({ code: null, signal: null, confirmed: true });
    expect(await readdir(paths.workspace)).toEqual([]);
  }, 30000);

  supervisorIt('refuses to run a command when the helper is missing', async () => {
    const paths = await fixture(); const results: string[] = [];
    vi.stubEnv('O8_PI_WRITE_BIN', join(paths.workspace, 'missing-helper'));
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('missing', 'touch ran')], results) });
    await session.prompt('Run without the helper');
    expect(results[0]).toBe('Host operation failed');
    expect(receipts).toEqual([]);
    expect(await readdir(paths.workspace)).toEqual([]);
  }, 20000);

  // Last: unconfirmed cleanup refuses commands and writes for the rest of the host process.
  supervisorIt('refuses later commands when the supervisor ends without a receipt', async () => {
    const paths = await fixture();
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('lost', 'echo $PPID > supervisor.pid; echo $$ > command.pid; touch started; sleep 30'),
        { type: 'toolCall', id: 'write', name: 'write_file', arguments: { path: 'note.txt', content: 'refused' } }]) });
    const run = session.prompt('Lose the supervisor');
    await vi.waitFor(() => readFile(join(paths.workspace, 'started')), { timeout: 10_000, interval: 50 });
    const [supervisor, commandPid] = await pids(paths.workspace, ['supervisor.pid', 'command.pid']);
    expect(supervisor).toBe(supervisors[0]);
    process.kill(supervisor, 'SIGKILL');
    await run;
    expect(piCommandCleanupUnconfirmed()).toBe(true);
    expect((await readdir(paths.workspace)).sort()).toEqual(['command.pid', 'started', 'supervisor.pid']);
    // The orphaned command group is outside any supervisor now; end only this test's processes.
    process.kill(-commandPid, 'SIGKILL');
  }, 30000);


});
