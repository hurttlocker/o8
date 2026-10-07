import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { createPiSdkSession } from '@/lib/pi/sdk/session';
import type { PiToolCall } from '@/lib/pi/sdk/tools';
import { getDataDir } from '@/lib/data-dir-migration';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));

const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions',
  provider: 'o8-managed', baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'],
  contextWindow: 16000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
// The ordering case also commits an approved write through the native helper.
beforeAll(() => { buildPiWriteHelper(); }, 600_000);
const roots: string[] = [];
const clients: Awaited<ReturnType<typeof createPiSdkSession>>[] = [];
afterEach(async () => {
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
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function pids(dir: string, ...names: string[]) {
  return Promise.all(names.map(async name => Number((await readFile(join(dir, name), 'utf8')).trim())));
}
// A background child in the command's group and a job-control child in its own group.
const TREE = 'sleep 30 & echo $! > group.pid; sh -c \'set -m; sleep 30 & echo $! > job.pid; wait\' & sleep 0.3';

describe('Pi governed command tool through the real worker', () => {
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
    for (const pid of await pids(paths.workspace, 'group.pid', 'job.pid')) await vi.waitFor(() => expect(alive(pid)).toBe(false));
  }, 20000);

  it('ends the whole process tree when the output cap is reached', async () => {
    const paths = await fixture(); const results: string[] = [];
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('loud', `${TREE}; while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done`)], results) });
    await session.prompt('Run a loud command');
    expect(results[0]).toContain('more than 50000 bytes of output');
    expect(Buffer.byteLength(results[0])).toBeLessThan(52_000);
    for (const pid of await pids(paths.workspace, 'group.pid', 'job.pid')) await vi.waitFor(() => expect(alive(pid)).toBe(false));
  }, 20000);

  it('ends the whole process tree on Stop', async () => {
    const paths = await fixture();
    const session = await client({ ...paths, model, approve: async () => true,
      transport: scripted([command('stop', `${TREE}; touch started; sleep 30`)]) });
    const run = session.prompt('Run until stopped');
    await vi.waitFor(() => readFile(join(paths.workspace, 'started')), { timeout: 10_000, interval: 50 });
    await session.abort(); await run;
    for (const pid of await pids(paths.workspace, 'group.pid', 'job.pid')) await vi.waitFor(() => expect(alive(pid)).toBe(false));
  }, 20000);

  it('ends background processes before a write from the same turn starts', async () => {
    const paths = await fixture(); const atWrite: { ran: boolean; groupAlive: boolean; jobAlive: boolean }[] = [];
    const session = await client({ ...paths, model,
      approve: async call => {
        if (call.name === 'write_file') {
          const [group, job] = await pids(paths.workspace, 'group.pid', 'job.pid');
          atWrite.push({ ran: (await readdir(paths.workspace)).includes('ran.txt'), groupAlive: alive(group), jobAlive: alive(job) });
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
});
