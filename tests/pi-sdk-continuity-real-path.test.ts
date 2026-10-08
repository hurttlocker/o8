import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { getDataDir } from '@/lib/data-dir-migration';
import * as workspaceFiles from '@/lib/fs/workspace-file';
import { createPiContinuityGuard, type PiContinuityPolicy } from '@/lib/pi/sdk/continuity';
import { withPiExclusive } from '@/lib/pi/sdk/command';
import { createPiSdkSession } from '@/lib/pi/sdk/session';
import { executePiTool, type PiApproval, type PiToolCall } from '@/lib/pi/sdk/tools';
import { buildPiWriteHelper } from './helpers/pi-write-helper';
import { byteContinuityPolicy, CONTINUITY_COMMAND } from './helpers/pi-continuity';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));

const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions',
  provider: 'o8-managed', baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'],
  contextWindow: 16000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const roots: string[] = [];
const clients: Awaited<ReturnType<typeof createPiSdkSession>>[] = [];
beforeAll(() => { buildPiWriteHelper(); }, 600_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  await rm(join(getDataDir(), 'policies.json'), { force: true });
  (await import('@/lib/approvals/policies')).refreshPolicyRules();
});

async function fixture(paths = ['source.txt']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'o8-pi-continuity-'))); roots.push(root);
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  for (const path of paths) await writeFile(join(workspace, path), 'observed source');
  await writeFile(join(workspace, 'unrelated.txt'), 'unrelated');
  const source = await byteContinuityPolicy(workspace, paths);
  const guard = createPiContinuityGuard(workspace, source.policy);
  const execute = (call: PiToolCall, approve: PiApproval = async () => true,
    signal = new AbortController().signal) => executePiTool(workspace, call, approve, signal, { continuity: guard });
  return { root, workspace, stateDir: join(root, 'state'), ...source, guard, execute };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const write: PiToolCall = { name: 'write_file', args: { path: 'result.txt', content: 'approved result' } };
const command: PiToolCall = { name: 'run_command', args: { command: CONTINUITY_COMMAND } };
const read = (path = 'source.txt'): PiToolCall => ({ name: 'read_file', args: { path } });
const mutate = (f: Fixture, text = 'changed source', path = 'source.txt') => writeFile(join(f.workspace, path), text);
async function noAct(f: Fixture) {
  const files = await readdir(f.workspace);
  expect(files).not.toContain('result.txt'); expect(files).not.toContain('sentinel.txt');
  expect(files.some(path => path.startsWith('.o8-pi-'))).toBe(false);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, stopReason, model: model.id, api: model.api,
    provider: model.provider, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0,
      cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function events(answer: AssistantMessage): AssistantMessageEvent[] {
  return [{ type: 'start', partial: answer }, { type: 'done', reason: answer.stopReason as 'stop' | 'toolUse', message: answer }];
}
type ModelToolArgs = Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments'];
async function runWorker(f: Fixture, steps: Array<PiToolCall | (() => Promise<PiToolCall>)>,
  options: Partial<Parameters<typeof createPiSdkSession>[0]> = {}) {
  let turn = 0;
  const session = await createPiSdkSession({ ...f, model, continuity: f.policy, approve: async () => true,
    maxModelCalls: steps.length + 1, maxToolCalls: steps.length,
    transport: async function* () {
      const step = steps[turn++];
      if (!step) { yield* events(message([{ type: 'text', text: 'Done' }])); return; }
      const call = typeof step === 'function' ? await step() : step;
      yield* events(message([{ type: 'toolCall', id: `call-${turn}`, name: call.name, arguments: call.args as ModelToolArgs }], 'toolUse'));
    }, ...options });
  clients.push(session);
  await session.prompt('Exercise the configured host source precondition');
  return readFile(session.sessionFile, 'utf8');
}
async function allowCommandWithoutApproval(f: Fixture) {
  await writeFile(join(getDataDir(), 'policies.json'), JSON.stringify([
    { id: 'mutation-shell', requiresApproval: false, workspacePath: f.workspace },
  ]));
  (await import('@/lib/approvals/policies')).refreshPolicyRules();
}

describe('Pi optional host continuity through real tools and worker', () => {
  it('leaves unconfigured sessions unchanged even when an unrelated source changes', async () => {
    const f = await fixture(); await mutate(f);
    const log = await runWorker(f, [write, command], { continuity: undefined });
    expect(await readFile(join(f.workspace, 'result.txt'), 'utf8')).toBe('approved result');
    expect(await readFile(join(f.workspace, 'sentinel.txt'), 'utf8')).toBe('ran');
    expect(log).not.toContain('Host operation failed'); expect(f.inspections).toEqual([]);
  }, 20_000);

  it('permits fresh approved writes and commands through the real Pi process', async () => {
    const f = await fixture(); const approve = vi.fn(async () => true);
    const log = await runWorker(f, [write, command], { approve });
    expect(await readFile(join(f.workspace, 'result.txt'), 'utf8')).toBe('approved result');
    expect(await readFile(join(f.workspace, 'sentinel.txt'), 'utf8')).toBe('ran');
    expect(log).not.toContain('Host operation failed'); expect(approve).toHaveBeenCalledTimes(2);
    expect(f.inspections.map(check => check.action.name)).toEqual(['write_file', 'run_command']);
  }, 20_000);

  it.each(['changed', 'missing', 'malformed', 'absent'] as const)('refuses %s evidence before write or process creation in the worker', async state => {
    const f = await fixture();
    if (state === 'changed') await mutate(f);
    if (state === 'missing') await rm(join(f.workspace, 'source.txt'));
    if (state === 'malformed') f.policy.originalEvidence = { 'source.txt': 'not source bytes' };
    if (state === 'absent') f.policy.originalEvidence = undefined;
    const log = await runWorker(f, [write, command]);
    await noAct(f); expect(log).toContain('Host operation'); expect(f.inspections).toHaveLength(2);
    expect(f.inspections.every(check => check.reads.length === 0)).toBe(true);
  }, 20_000);

  it('appends genuine host-read evidence without replacing original evidence or opaque intent, then refuses a second change', async () => {
    const f = await fixture(); await mutate(f);
    const original = structuredClone(f.original);
    const log = await runWorker(f, [write, read(), write,
      async () => { await mutate(f, 'changed again'); return command; }]);
    expect(await readFile(join(f.workspace, 'result.txt'), 'utf8')).toBe('approved result');
    await expect(readFile(join(f.workspace, 'sentinel.txt'))).rejects.toThrow();
    expect(log).toContain('changed source'); expect(log).toContain('Wrote result.txt');
    expect(f.inspections.map(check => check.reads.length)).toEqual([0, 1, 1]);
    for (const check of f.inspections) {
      expect(check.intentRef).toBe('opaque-authorized-intent'); expect(check.originalEvidence).toEqual(original);
    }
    expect(f.inspections[1].reads[0]).toEqual({ workspace: f.workspace, path: 'source.txt',
      bytes: Uint8Array.from(Buffer.from('changed source')) });
  }, 20_000);

  it('does not let unrelated or failed worker reads certify changed dependencies', async () => {
    const f = await fixture(); await mutate(f);
    await writeFile(join(f.workspace, 'unrelated.txt'), 'changed source');
    const log = await runWorker(f, [read('unrelated.txt'), read('missing.txt'),
      { name: 'read_file', args: { path: 'source.txt', offset: 0, limit: 2 } }, write, command]);
    await noAct(f); expect(log).toContain('Host operation');
    expect(f.inspections.every(check => check.reads.length === 0)).toBe(true);
  }, 20_000);

  it('requires each changed dependency rather than treating any successful read as refresh', async () => {
    const f = await fixture(['source.txt', 'second.txt']);
    await mutate(f); await mutate(f, 'second changed', 'second.txt');
    await f.execute(read()); await expect(f.execute(write)).rejects.toThrow('Source continuity');
    await noAct(f); await f.execute(read('second.txt')); await f.execute(write);
    expect(f.inspections.map(check => check.reads.length)).toEqual([1, 2]);
  });

  it('appends a second required read and uses its bytes without rewriting the first observation', async () => {
    const f = await fixture(); await mutate(f, 'first change'); await f.execute(read());
    await mutate(f, 'second change'); await expect(f.execute(command)).rejects.toThrow('Source continuity');
    await f.execute(read()); await f.execute(command);
    expect(f.inspections.map(check => check.reads.length)).toEqual([1, 2]);
    expect(f.inspections[1].reads.map(read => Buffer.from(read.bytes).toString())).toEqual(['first change', 'second change']);
    expect(f.inspections[1].originalEvidence).toEqual(f.original);
  });

  it.each([write, command])('rechecks $name after approval has waited', async call => {
    const f = await fixture();
    await expect(f.execute(call, async () => { await mutate(f); return true; })).rejects.toThrow('Source continuity');
    await noAct(f); expect(f.inspections).toHaveLength(1);
  });

  it.each([write, command])('rechecks $name after the exclusive lock has waited', async call => {
    const f = await fixture(); const holding = deferred(); const release = deferred(); const approved = deferred();
    const held = withPiExclusive(async () => { holding.resolve(); await release.promise; });
    await holding.promise;
    const pending = f.execute(call, async () => { approved.resolve(); return true; });
    const rejected = expect(pending).rejects.toThrow('Source continuity');
    await approved.promise; await mutate(f); release.resolve(); await held; await rejected;
    await noAct(f); expect(f.inspections).toHaveLength(1);
  });

  it.each(['fresh', 'stale'] as const)('still checks %s commands when normal command policy waives approval', async state => {
    const f = await fixture(); await allowCommandWithoutApproval(f);
    if (state === 'stale') await mutate(f);
    const approve = vi.fn(async () => false);
    await runWorker(f, [command], { approve });
    expect(approve).not.toHaveBeenCalled(); expect(f.inspections).toHaveLength(1);
    if (state === 'fresh') expect(await readFile(join(f.workspace, 'sentinel.txt'), 'utf8')).toBe('ran');
    else await noAct(f);
  }, 20_000);

  it('refuses a policy-waived command whose source changes while waiting for the host lock', async () => {
    const f = await fixture(); await allowCommandWithoutApproval(f);
    const holding = deferred(); const release = deferred();
    const held = withPiExclusive(async () => { holding.resolve(); await release.promise; }); await holding.promise;
    const approve = vi.fn(async () => true);
    const pending = f.execute(command, approve); const rejected = expect(pending).rejects.toThrow('Source continuity');
    await mutate(f); release.resolve(); await held; await rejected;
    expect(approve).not.toHaveBeenCalled(); await noAct(f);
  });

  it('refuses arbitrary command scope even when the known sources are fresh', async () => {
    const f = await fixture();
    await expect(f.execute({ name: 'run_command', args: { command: `${CONTINUITY_COMMAND}; printf unknown > other.txt` } }))
      .rejects.toThrow('Source continuity');
    await noAct(f); await expect(readFile(join(f.workspace, 'other.txt'))).rejects.toThrow();
  });

  it.each([undefined, null, {}, { status: 'fresh' }, { status: 'fresh', scope: 'unknown' }])('fails closed on malformed or incomplete adapter result %j', async result => {
    const f = await fixture();
    const guard = createPiContinuityGuard(f.workspace, { ...f.policy, inspect: async () => result as never });
    for (const call of [write, command]) await expect(executePiTool(f.workspace, call, async () => true,
      new AbortController().signal, { continuity: guard })).rejects.toThrow('Source continuity');
    await noAct(f);
  });

  it('does not refresh on adapter errors or refusals, and keeps normal approval mandatory', async () => {
    const f = await fixture(); await mutate(f);
    await expect(f.execute(write)).rejects.toThrow('Source continuity');
    await expect(f.execute(command)).rejects.toThrow('Source continuity');
    expect(f.inspections.every(check => check.reads.length === 0)).toBe(true);
    await f.execute(read());
    await expect(f.execute(write, async () => false)).rejects.toThrow('not approved');
    await expect(f.execute(command, async () => false)).rejects.toThrow('not approved');
    const guard = createPiContinuityGuard(f.workspace, { ...f.policy, inspect: async () => { throw new Error('private error'); } });
    await expect(executePiTool(f.workspace, write, async () => true, new AbortController().signal,
      { continuity: guard })).rejects.toThrow('Source continuity');
    await noAct(f);
  });

  it('does not let configured freshness bypass the existing command-policy block', async () => {
    const f = await fixture(); const approve = vi.fn(async () => true);
    await expect(f.execute({ name: 'run_command', args: { command: 'sudo touch sentinel.txt' } }, approve))
      .rejects.toThrow('blocked by policy');
    expect(approve).not.toHaveBeenCalled(); expect(f.inspections).toEqual([]); await noAct(f);
  });

  it.each([write, command])('rechecks authority after a pending $name continuity inspection', async call => {
    const f = await fixture(); const entered = deferred(); const release = deferred();
    let allowed = true;
    const authorize = vi.fn(async () => allowed);
    const guard = createPiContinuityGuard(f.workspace, { ...f.policy, inspect: async () => {
      entered.resolve(); await release.promise; return { status: 'fresh', scope: 'complete' };
    } });
    const pending = executePiTool(f.workspace, call, async () => true, new AbortController().signal,
      { continuity: guard, authorize });
    const rejected = expect(pending).rejects.toThrow('no longer allows');
    await entered.promise; allowed = false; release.resolve(); await rejected;
    expect(authorize).toHaveBeenCalledTimes(2); await noAct(f);
  });

  it('refuses Stop after a pending freshness inspection even if it eventually returns fresh', async () => {
    const f = await fixture(); const entered = deferred(); const release = deferred(); const controller = new AbortController();
    const guard = createPiContinuityGuard(f.workspace, { ...f.policy, inspect: async input => {
      const result = await f.policy.inspect(input, controller.signal); entered.resolve(); await release.promise; return result;
    } });
    const pending = executePiTool(f.workspace, write, async () => true, controller.signal, { continuity: guard });
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise; controller.abort(); release.resolve(); await rejected; await noAct(f);
    expect(f.inspections[0].reads).toEqual([]);
  });

  it.each([write, command])('releases the host lock when Stop interrupts a hung $name inspection', async call => {
    const f = await fixture(); const entered = deferred(); const release = deferred(); const controller = new AbortController();
    const guard = createPiContinuityGuard(f.workspace, { ...f.policy, inspect: async () => {
      entered.resolve(); await release.promise; return { status: 'fresh', scope: 'complete' };
    } });
    const pending = executePiTool(f.workspace, call, async () => true, controller.signal, { continuity: guard });
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise; controller.abort(); await rejected;
    await withPiExclusive(async () => { await noAct(f); });
    // A late successful adapter cannot revive an already stopped action.
    release.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); await noAct(f);
  });

  it('does not record aborted, oversized, lossy UTF-8, symlink or close-failed reads', async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort();
    await mutate(f); await expect(f.execute(read(), undefined, controller.signal)).rejects.toThrow();
    await mutate(f, 'x'.repeat(50_001)); await expect(f.execute(read())).rejects.toThrow('size limit');
    await writeFile(join(f.workspace, 'source.txt'), Buffer.from([0xff, 0xfe])); await f.execute(read());
    await rm(join(f.workspace, 'source.txt')); await symlink('unrelated.txt', join(f.workspace, 'source.txt'));
    await expect(f.execute(read())).rejects.toThrow('Symlink');
    await rm(join(f.workspace, 'source.txt')); await mutate(f);
    const open = workspaceFiles.openWorkspaceFile;
    const spy = vi.spyOn(workspaceFiles, 'openWorkspaceFile').mockImplementation(async (...args) => {
      const opened = await open(...args); const close = opened.handle.close.bind(opened.handle);
      vi.spyOn(opened.handle, 'close').mockImplementation(async () => { await close(); throw new Error('close failed'); });
      return opened;
    });
    await expect(f.execute(read())).rejects.toThrow('close failed'); spy.mockRestore();
    await expect(f.execute(write)).rejects.toThrow('Source continuity'); await noAct(f);
    expect(f.inspections[0].reads).toEqual([]);
  });

  it('does not record a read that fails after its first chunk but before confirming EOF', async () => {
    const f = await fixture(); await mutate(f);
    const open = workspaceFiles.openWorkspaceFile;
    const spy = vi.spyOn(workspaceFiles, 'openWorkspaceFile').mockImplementation(async (...args) => {
      const opened = await open(...args); const read = opened.handle.read.bind(opened.handle); let chunks = 0;
      vi.spyOn(opened.handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof read>) => {
        if (++chunks > 1) throw new Error('partial read failed');
        return read(...readArgs);
      });
      return opened;
    });
    await expect(f.execute(read())).rejects.toThrow('partial read failed'); spy.mockRestore();
    await expect(f.execute(write)).rejects.toThrow('Source continuity'); await noAct(f);
    expect(f.inspections[0].reads).toEqual([]);
  });

  it('rejects model-supplied authority or observations rather than accepting them as host options', async () => {
    const f = await fixture(); await mutate(f);
    const log = await runWorker(f, [{ ...write, args: { ...write.args,
      continuity: { status: 'fresh' }, intentRef: 'model-replacement', reads: [{ path: 'source.txt' }] } }, command]);
    await noAct(f); expect(log).toContain('Host operation');
    expect(f.inspections).toHaveLength(1); expect(f.inspections[0].intentRef).toBe(f.policy.intentRef);
    expect(f.inspections[0].reads).toEqual([]);
  }, 20_000);

  it('binds observations to the original workspace and isolates each adapter invocation from mutations', async () => {
    const f = await fixture(); await mutate(f);
    const other = join(f.root, 'other'); await mkdir(other); await writeFile(join(other, 'source.txt'), 'changed source');
    await executePiTool(other, read(), async () => true, new AbortController().signal, { continuity: f.guard });
    await expect(f.execute(write)).rejects.toThrow('Source continuity');
    expect(f.inspections[0].reads).toEqual([]);
    const guard = createPiContinuityGuard(f.workspace, { ...f.policy, inspect: async (input, signal) => {
      const result = await f.policy.inspect(input, signal);
      input.intentRef = 'adapter-mutated';
      (input.originalEvidence as Record<string, unknown>)['source.txt'] = new Uint8Array();
      if (input.reads[0]) input.reads[0].bytes.fill(0);
      return result;
    } });
    await executePiTool(f.workspace, read(), async () => true, new AbortController().signal, { continuity: guard });
    for (let n = 0; n < 2; n++) await guard.assertCurrent(f.workspace, { name: 'write_file', path: 'result.txt' }, new AbortController().signal);
    for (const check of f.inspections.slice(1)) {
      expect(check.intentRef).toBe(f.policy.intentRef); expect(check.originalEvidence).toEqual(f.original);
      expect(Buffer.from(check.reads[0].bytes).toString()).toBe('changed source');
    }
    await expect(guard.assertCurrent(other, { name: 'write_file', path: 'result.txt' }, new AbortController().signal))
      .rejects.toThrow('Source continuity');
  });

  it.each([{ inspect: undefined }, { intentRef: '', requiredReadPaths: ['source.txt'] },
    { intentRef: 'opaque', requiredReadPaths: [] }, { intentRef: 'opaque', requiredReadPaths: ['../source.txt'] }])(
    'refuses an invalid configured host policy %j', async value => {
      const f = await fixture();
      expect(() => createPiContinuityGuard(f.workspace, { ...f.policy, ...value } as unknown as PiContinuityPolicy))
        .toThrow('Source continuity'); await noAct(f);
    });

  it('fails closed on shared backing memory that cannot be snapshotted', async () => {
    const f = await fixture(); const shared = new SharedArrayBuffer(1); const bytes = new Uint8Array(shared); bytes[0] = 42;
    const values = [shared, { shared }, new Map([[shared, 'key']]), new Map([['bytes', shared]]), new Set([shared]),
      new Error('opaque evidence', { cause: shared }), new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })];
    for (const originalEvidence of values) expect(() => createPiContinuityGuard(f.workspace,
      { ...f.policy, originalEvidence })).toThrow('Source continuity');
    expect(bytes[0]).toBe(42); await noAct(f);
  });

  it.each([false, true])('detaches view bytes (shared %s) so caller and adapter cannot rewrite original evidence', async shared => {
    const f = await fixture(); const bytes = new Uint8Array(shared ? new SharedArrayBuffer(1) : new ArrayBuffer(1)); bytes[0] = 42;
    const guard = createPiContinuityGuard(f.workspace, { ...f.policy,
      originalEvidence: { bytes, map: new Map([['bytes', bytes]]), set: new Set([bytes]) },
      inspect: async input => {
        const evidence = input.originalEvidence as { bytes: Uint8Array; map: Map<string, Uint8Array>; set: Set<Uint8Array> };
        const views = [evidence.bytes, evidence.map.get('bytes')!, ...evidence.set];
        for (const view of views) expect(view[0]).toBe(42);
        for (const view of views) view[0] = 0;
        return { status: 'fresh', scope: 'complete' };
      },
    });
    bytes[0] = 7;
    for (let n = 0; n < 2; n++) await guard.assertCurrent(f.workspace, { name: 'write_file', path: 'result.txt' }, new AbortController().signal);
    expect(bytes[0]).toBe(7); await noAct(f);
  });
});
