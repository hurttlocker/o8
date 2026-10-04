import { afterEach, describe, expect, it, vi } from 'vitest';
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { createPiSdkSession, requirePiNode } from '@/lib/pi/sdk/session';
import { createManagedPiTransport } from '@/lib/pi/sdk/transport';
import * as workspaceFiles from '@/lib/fs/workspace-file';

// These seams exist only in Vitest's module mocks, never in session options.
const race = vi.hoisted(() => ({ afterLstat: undefined as undefined | ((path: string) => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await fs.lstat(...args);
    await race.afterLstat?.(String(args[0]));
    return stat;
  } };
});

const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions',
  provider: 'o8-managed', baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'],
  contextWindow: 16000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const roots: string[] = [];
const clients: Awaited<ReturnType<typeof createPiSdkSession>>[] = [];
afterEach(async () => { race.afterLstat = undefined; vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'o8-pi-sdk-')); roots.push(root);
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
async function client(options: Parameters<typeof createPiSdkSession>[0]) {
  const session = await createPiSdkSession(options); clients.push(session); return session;
}

describe('managed Pi SDK real worker', () => {
  it('checks the prerequisite without installing or changing Node', () => {
    expect(() => requirePiNode('22.18.0')).toThrow('22.19');
    expect(() => requirePiNode('22.19.0')).not.toThrow();
    expect(() => requirePiNode('24.19.0')).not.toThrow();
  });
  it('runs approved file tools, waits for settled, and resumes persisted history in a new child', async () => {
    const paths = await fixture(); const seen: string[] = []; let calls = 0; let approved = 0;
    const first = await client({ ...paths, model, onEvent: event => seen.push(String(event.type)),
      approve: async call => { approved++; return call.args.content === 'hello π'; },
      transport: async function* () {
        yield* events(++calls === 1 ? message([{ type: 'toolCall', id: 'write-1', name: 'write_file', arguments: { path: 'note.txt', content: 'hello π' } }], 'toolUse')
          : message([{ type: 'text', text: 'Saved π' }]));
      } });
    expect(first.tools).toEqual(['read_file', 'write_file']);
    expect(await first.prompt('Write a note')).toMatchObject({ text: 'Saved π', stopReason: 'stop' });
    expect(await readFile(join(paths.workspace, 'note.txt'), 'utf8')).toBe('hello π');
    expect(approved).toBe(1); expect(seen.at(-1)).toBe('agent_settled');
    await first.close(); expect(first.running).toBe(false);
    const second = await client({ ...paths, model, sessionFile: first.sessionFile,
      transport: async function* (context) { expect(context.messages.length).toBeGreaterThan(3); yield* events(message([{ type: 'text', text: 'Resumed' }])); } });
    expect(second.sessionId).toBe(first.sessionId); expect(second.surfaceId).toBe(first.surfaceId);
    expect((await second.prompt('Continue')).text).toBe('Resumed');
  }, 20000);
  it('denies unapproved writes and outside-root reads without loading workspace extensions', async () => {
    const paths = await fixture(); await writeFile(join(paths.root, 'outside'), 'private fixture');
    await symlink('../outside', join(paths.workspace, 'link'));
    await mkdir(join(paths.workspace, '.pi', 'extensions'), { recursive: true });
    await writeFile(join(paths.workspace, '.pi', 'extensions', 'bad.js'), 'throw new Error("ambient extension loaded")');
    let calls = 0;
    const session = await client({ ...paths, model, approve: async () => false,
      transport: async function* (context) {
        calls++;
        if (calls === 1) yield* events(message([{ type: 'toolCall', id: 'deny', name: 'write_file', arguments: { path: 'denied.txt', content: 'no' } }], 'toolUse'));
        else if (calls === 2) { expect(JSON.stringify(context)).toContain('Host operation'); yield* events(message([{ type: 'toolCall', id: 'escape', name: 'read_file', arguments: { path: 'link' } }], 'toolUse')); }
        else { expect(JSON.stringify(context)).not.toContain('private fixture'); yield* events(message([{ type: 'text', text: 'Denied' }])); }
      } });
    await session.prompt('Try denied operations');
    await expect(readFile(join(paths.workspace, 'denied.txt'))).rejects.toThrow();
    expect(calls).toBe(3);
  }, 15000);
  it('propagates Stop while transport is pending and retires only its own child', async () => {
    const paths = await fixture(); let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; }); let cancelled = false; let turns = 0;
    const session = await client({ ...paths, model, transport: async function* (_context, signal) {
      if (++turns === 1) { yield* events(message([{ type: 'text', text: 'Previous unrelated success' }])); return; }
      started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
    } });
    expect((await session.prompt('First turn')).text).toBe('Previous unrelated success');
    const pending = session.prompt('Wait'); await began; await session.abort();
    expect(await pending).toMatchObject({ stopReason: 'aborted', text: '' }); expect(cancelled).toBe(true);
    await session.close(); expect(session.running).toBe(false);
  }, 15000);
  it('uses managed-only host transport and decodes fragmented tool calls without worker credentials', async () => {
    const paths = await fixture(); let requests = 0;
    const transport = createManagedPiTransport({ model,
      resolveRoute: async () => ({ via: 'proxy', url: 'https://managed.example/v1/inference', headers: { Authorization: 'Bearer synthetic-host-only' } }),
      fetch: async (url, init) => {
        expect(url).toBe('https://managed.example/v1/inference');
        expect(init?.redirect).toBe('error'); expect(init?.headers).toEqual({ Authorization: 'Bearer synthetic-host-only' });
        const body = JSON.parse(String(init?.body)); expect(body.model).toBe('fixture'); requests++;
        const chunks = requests === 1 ? [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'tool1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"note.txt"}' } }] }, finish_reason: 'tool_calls' }] },
        ] : [{ choices: [{ delta: { content: 'Read fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }];
        const bytes = new TextEncoder().encode(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
        return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
      } });
    await writeFile(join(paths.workspace, 'note.txt'), 'fixture');
    const session = await client({ ...paths, model, transport });
    const result = await session.prompt('Read note');
    expect(result.text).toBe('Read fixture'); expect(requests).toBe(2);
    expect(await readFile(session.sessionFile, 'utf8')).not.toContain('synthetic-host-only');
  }, 15000);
  it('refuses protected aliases and detects file identity changes during approval', async () => {
    const paths = await fixture(); await mkdir(join(paths.workspace, '.git'));
    await writeFile(join(paths.workspace, '.git', 'config'), 'protected fixture');
    await symlink('.git', join(paths.workspace, 'alias'));
    await writeFile(join(paths.workspace, 'note.txt'), 'original');
    let calls = 0;
    const session = await client({ ...paths, model, approve: async call => {
      expect(call.before).toBe('original');
      await rename(join(paths.workspace, 'note.txt'), join(paths.workspace, 'original.txt'));
      await writeFile(join(paths.workspace, 'note.txt'), 'replacement');
      return true;
    }, transport: async function* (context) {
      calls++;
      if (calls === 1) yield* events(message([{ type: 'toolCall', id: 'alias', name: 'read_file', arguments: { path: 'alias/config' } }], 'toolUse'));
      else if (calls === 2) { expect(JSON.stringify(context)).not.toContain('protected fixture'); yield* events(message([{ type: 'toolCall', id: 'write', name: 'write_file', arguments: { path: 'note.txt', content: 'wrong target' } }], 'toolUse')); }
      else yield* events(message([{ type: 'text', text: 'Denied' }]));
    } });
    await session.prompt('Exercise approval race');
    expect(await readFile(join(paths.workspace, 'note.txt'), 'utf8')).toBe('replacement');
    expect(await readFile(join(paths.workspace, 'original.txt'), 'utf8')).toBe('original');
  }, 15000);
  it('creates no outside file when a parent becomes a symlink after the final containment check', async () => {
    const paths = await fixture(); const parent = join(paths.workspace, 'folder');
    const outside = join(paths.root, 'outside'); await mkdir(parent); await mkdir(outside);
    let parentChecks = 0; let swapped = false; let calls = 0;
    race.afterLstat = async path => {
      if (path !== parent || ++parentChecks !== 4) return;
      await rename(parent, join(paths.workspace, 'original-folder'));
      await symlink(outside, parent); swapped = true;
    };
    const session = await client({ ...paths, model, approve: async () => true,
      transport: async function* () {
        yield* events(++calls === 1 ? message([{ type: 'toolCall', id: 'create-race', name: 'write_file',
          arguments: { path: 'folder/new.txt', content: 'approved bytes' } }], 'toolUse')
          : message([{ type: 'text', text: 'Finished' }]));
      } });
    await session.prompt('Exercise parent swap');
    expect(swapped).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(join(paths.workspace, 'original-folder'))).toEqual([]);
    expect(await readFile(session.sessionFile, 'utf8')).toContain('Host operation denied');
  }, 15000);
  it('refuses a hard link added after the async content recheck without modifying either alias', async () => {
    const paths = await fixture(); const target = join(paths.workspace, 'note.txt');
    const alias = join(paths.root, 'outside-alias'); const protectedAlias = join(paths.workspace, '.env');
    await writeFile(target, 'original'); let snapshots = 0; let linked = false; let calls = 0;
    const open = workspaceFiles.openWorkspaceFile;
    vi.spyOn(workspaceFiles, 'openWorkspaceFile').mockImplementation(async (...args) => {
      const opened = await open(...args); const read = opened.handle.read.bind(opened.handle);
      vi.spyOn(opened.handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        if (result.bytesRead === 0 && ++snapshots === 2) {
          await link(target, alias); await link(target, protectedAlias); linked = true;
        }
        return result;
      });
      return opened;
    });
    const session = await client({ ...paths, model, approve: async () => true,
      transport: async function* () {
        yield* events(++calls === 1 ? message([{ type: 'toolCall', id: 'link-race', name: 'write_file',
          arguments: { path: 'note.txt', content: 'approved replacement' } }], 'toolUse')
          : message([{ type: 'text', text: 'Finished' }]));
      } });
    await session.prompt('Exercise late hard link');
    expect(linked).toBe(true); expect((await lstat(target)).nlink).toBe(3);
    expect(await readFile(alias, 'utf8')).toBe('original');
    expect(await readFile(protectedAlias, 'utf8')).toBe('original');
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readFile(session.sessionFile, 'utf8')).toContain('Host operation denied');
  }, 15000);
  it('Stop prevents a late approval from writing and model-call budgets fail closed', async () => {
    const paths = await fixture(); let resolveApproval!: (value: boolean) => void; let entered!: () => void;
    const approvalEntered = new Promise<void>(resolve => { entered = resolve; });
    const session = await client({ ...paths, model,
      approve: async () => { entered(); return new Promise<boolean>(resolve => { resolveApproval = resolve; }); },
      transport: async function* () { yield* events(message([{ type: 'toolCall', id: 'write', name: 'write_file', arguments: { path: 'never.txt', content: 'denied' } }], 'toolUse')); } });
    const pending = session.prompt('Wait for approval'); await approvalEntered;
    const abort = session.abort(); resolveApproval(true); await abort; await pending;
    await expect(readFile(join(paths.workspace, 'never.txt'))).rejects.toThrow();
    await session.close();
    const limited = await client({ ...paths, model, maxModelCalls: 1,
      transport: async function* () { yield* events(message([{ type: 'toolCall', id: 'read', name: 'read_file', arguments: { path: 'missing' } }], 'toolUse')); } });
    expect((await limited.prompt('Try repeated calls')).stopReason).toBe('error');
  }, 15000);
  it.each([401, 402, 429])('handles managed HTTP %s without leaking response bodies or retrying', async status => {
    const paths = await fixture(); let attempts = 0;
    const transport = createManagedPiTransport({ model,
      resolveRoute: async () => ({ via: 'proxy', url: 'https://managed.example/v1/inference', headers: {} }),
      fetch: async () => { attempts++; return new Response('sensitive upstream body', { status }); } });
    const session = await client({ ...paths, model, transport });
    expect((await session.prompt('Try managed inference')).stopReason).toBe('error');
    expect(attempts).toBe(1);
    expect(await readFile(session.sessionFile, 'utf8')).not.toContain('sensitive upstream body');
  }, 15000);
  it('fails closed for absent entitlement and refuses cross-workspace resume', async () => {
    const paths = await fixture(); let fetched = false;
    const session = await client({ ...paths, model, transport: createManagedPiTransport({ model,
      resolveRoute: async () => null, fetch: async () => { fetched = true; throw new Error('unexpected'); } }) });
    expect((await session.prompt('No entitlement')).stopReason).toBe('error'); expect(fetched).toBe(false);
    await session.close();
    const another = join(paths.root, 'another'); await mkdir(another);
    await expect(createPiSdkSession({ ...paths, workspace: another, model, sessionFile: session.sessionFile })).rejects.toThrow();
  }, 15000);

  it('redacts failure payloads carried inside a successful SSE response', async () => {
    const paths = await fixture(); const observed: unknown[] = [];
    const transport = createManagedPiTransport({ model,
      resolveRoute: async () => ({ via: 'proxy', url: 'https://managed.example/v1/inference', headers: {} }),
      fetch: async () => new Response('data: {"error":{"message":"synthetic-secret-provider-body"}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    const session = await client({ ...paths, model, transport, onEvent: event => observed.push(event) });
    expect((await session.prompt('Try an SSE error')).stopReason).toBe('error');
    expect(JSON.stringify(observed)).not.toContain('synthetic-secret-provider-body');
    expect(await readFile(session.sessionFile, 'utf8')).not.toContain('synthetic-secret-provider-body');
  }, 15000);

});
