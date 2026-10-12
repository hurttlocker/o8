import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { createPiSdkSession } from '@/lib/pi/sdk/session';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));

const model: Model<'openai-completions'> = { id: 'scripted', name: 'scripted', api: 'openai-completions', provider: 'o8-managed',
  baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000, maxTokens: 1_000 };
// Approved writes go through the native helper from the source checkout's cargo build.
beforeAll(() => { buildPiWriteHelper(); }, 600_000);
const roots: string[] = [];
const sessions: Array<Awaited<ReturnType<typeof createPiSdkSession>>> = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'o8-pi-refusal-')));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const stateDir = join(root, 'state');
  await mkdir(workspace); await mkdir(stateDir);
  await writeFile(join(workspace, 'notes.txt'), 'count = 1\n');
  await writeFile(join(root, 'outside.txt'), 'private outside');
  return { root, workspace, stateDir };
}
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', content, stopReason, model: model.id, api: model.api, provider: model.provider, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function events(answer: AssistantMessage): AssistantMessageEvent[] {
  return [{ type: 'start', partial: answer }, { type: 'done', reason: answer.stopReason as 'stop' | 'toolUse', message: answer }];
}
type ToolResult = { role?: string; toolName?: string; content?: Array<{ text?: string }> };
/** Calls each tool in turn and records the tool result text the model saw for it. */
function scripted(calls: Array<{ name: string; arguments: Record<string, string> }>, seen: string[]) {
  let step = 0;
  return async function* (context: { messages: unknown[] }) {
    const last = (context.messages as ToolResult[]).at(-1);
    if (last?.role === 'toolResult') seen.push((last.content ?? []).map(part => part.text ?? '').join(''));
    const next = calls[step++];
    yield* events(next ? message([{ type: 'toolCall', id: `c${step}`, name: next.name, arguments: next.arguments }], 'toolUse')
      : message([{ type: 'text', text: 'Done' }]));
  };
}

describe('built-in agent tool errors (#3556)', () => {
  it('tells the model why o8 refused a call and keeps other host errors generic', async () => {
    const paths = await fixture(); const seen: string[] = [];
    const session = await createPiSdkSession({ ...paths, model, approve: async () => false,
      transport: scripted([
        { name: 'write_file', arguments: { path: 'notes.txt', content: 'count = 2\n' } },
        { name: 'run_command', arguments: { command: 'eval "touch blocked.txt"' } },
        { name: 'run_command', arguments: { command: 'touch ran.txt' } },
        { name: 'read_file', arguments: { path: 'missing.txt' } },
        { name: 'read_file', arguments: { path: '../outside.txt' } },
      ], seen) });
    sessions.push(session);
    await session.prompt('Try refused calls');

    expect(seen).toEqual([
      'File write was not approved',
      'Command is blocked by policy',
      'Command was not approved',
      'File not found',
      'Invalid workspace path',
    ]);
    expect(seen.join('\n')).not.toContain('private outside');
    expect(await readFile(join(paths.workspace, 'notes.txt'), 'utf8')).toBe('count = 1\n');
    await expect(readFile(join(paths.workspace, 'ran.txt'))).rejects.toThrow();
  }, 30_000);

  it('reads and writes an absolute path inside the workspace and refuses one outside', async () => {
    const paths = await fixture(); const seen: string[] = [];
    const session = await createPiSdkSession({ ...paths, model, approve: async () => true,
      transport: scripted([
        { name: 'read_file', arguments: { path: join(paths.workspace, 'notes.txt') } },
        { name: 'write_file', arguments: { path: join(paths.workspace, 'notes.txt'), content: 'count = 2\n' } },
        { name: 'read_file', arguments: { path: join(paths.root, 'outside.txt') } },
      ], seen) });
    sessions.push(session);
    await session.prompt('Use absolute paths');

    expect(seen).toEqual(['count = 1\n', 'Wrote notes.txt', 'Invalid workspace path']);
    expect(await readFile(join(paths.workspace, 'notes.txt'), 'utf8')).toBe('count = 2\n');
  }, 30_000);
});
