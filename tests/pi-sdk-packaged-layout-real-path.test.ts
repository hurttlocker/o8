import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { bundlePiSdk } from '../scripts/lib/pi-sdk-bundle.mjs';
import { createPiSdkSession } from '@/lib/pi/sdk/session';
import { piSdkScriptPath, piWriteHelperPath } from '@/lib/pi/sdk/scripts';
import { buildPiWriteHelper } from './helpers/pi-write-helper';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));

const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions',
  provider: 'o8-managed', baseUrl: 'https://o8-host.invalid/v1', reasoning: false, input: ['text'],
  contextWindow: 16000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
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
function hasNodeModulesAbove(path: string) {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) return true;
  }
  return false;
}

let exportRoot: string;
let piDir: string;
let writeHelper: string;
const roots: string[] = [];
const sessions: Awaited<ReturnType<typeof createPiSdkSession>>[] = [];

beforeAll(async () => {
  // Same build the desktop export runs, into a server layout with no node_modules.
  exportRoot = await realpath(await mkdtemp(join(tmpdir(), 'o8-pi-packaged-')));
  piDir = join(exportRoot, 'server', 'pi-sdk');
  bundlePiSdk({ root: process.cwd(), outDir: piDir });
  writeHelper = buildPiWriteHelper();
}, 600_000);
afterAll(async () => { await rm(exportRoot, { recursive: true, force: true }); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Pi SDK in the packaged server layout', () => {
  it('resolves the bundled scripts only in the packaged app and refuses a build without them', async () => {
    expect(piSdkScriptPath('worker.mjs', {})).toBe(join(process.cwd(), 'scripts', 'pi-sdk', 'worker.mjs'));
    const packaged = { O8_PACKAGED_APP: '1', O8_PI_SDK_DIR: piDir };
    expect(piSdkScriptPath('worker.mjs', packaged)).toBe(join(piDir, 'worker.mjs'));
    const empty = await realpath(await mkdtemp(join(tmpdir(), 'o8-pi-empty-'))); roots.push(empty);
    expect(() => piSdkScriptPath('worker.mjs', { O8_PACKAGED_APP: '1', O8_PI_SDK_DIR: empty }))
      .toThrow('Pi SDK worker.mjs is missing from this build');
    expect((await stat(join(piDir, 'worker.mjs'))).size).toBeGreaterThan(1_000_000);
    expect(hasNodeModulesAbove(join(piDir, 'worker.mjs'))).toBe(false);
  });

  it('resolves the native write helper the shell ships and refuses a packaged app without it', () => {
    expect(piWriteHelperPath({})).toBe(writeHelper);
    expect(piWriteHelperPath({ O8_PACKAGED_APP: '1', O8_PI_WRITE_BIN: writeHelper })).toBe(writeHelper);
    expect(() => piWriteHelperPath({ O8_PACKAGED_APP: '1' })).toThrow('Pi write helper is missing from this build');
    expect(() => piWriteHelperPath({ O8_PI_WRITE_BIN: join(exportRoot, 'missing') })).toThrow('Pi write helper is missing from this build');
  });

  it('runs an approved write through the bundled worker and helper with no Pi packages installed', async () => {
    vi.stubEnv('O8_PACKAGED_APP', '1');
    vi.stubEnv('O8_PI_SDK_DIR', piDir);
    vi.stubEnv('O8_PI_WRITE_BIN', writeHelper);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'o8-pi-packaged-run-'))); roots.push(root);
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    let calls = 0; let approved = 0;
    const session = await createPiSdkSession({ workspace, stateDir: join(root, 'state'), model,
      approve: async call => { approved++; return call.args.content === 'packaged π'; },
      transport: async function* () {
        yield* events(++calls === 1
          ? message([{ type: 'toolCall', id: 'write-1', name: 'write_file', arguments: { path: 'note.txt', content: 'packaged π' } }], 'toolUse')
          : message([{ type: 'text', text: 'Saved from the bundle' }]));
      } });
    sessions.push(session);
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(session.pid)], { encoding: 'utf8' });
    expect(command).toContain(`${piDir}${sep}worker.mjs`);
    expect(session.tools).toEqual(['read_file', 'write_file']);
    expect(await session.prompt('Write a note')).toMatchObject({ text: 'Saved from the bundle', stopReason: 'stop' });
    expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('packaged π');
    expect(approved).toBe(1);
  }, 60_000);
});
