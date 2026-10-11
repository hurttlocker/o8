import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => {} }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => { throw new Error('Fixture has no tools'); } }));
import { localAcpProcessLaunch, saveLocalAcpConnection } from './local-connection';
import { probeAcpModels } from '@/lib/orchestrator/acp-model-probe';
import { acpBackend } from '@/lib/lane/orchestrator-backends/acp';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

state.dir = mkdtempSync(join(tmpdir(), 'o8-local-acp-wire-'));
const peer = join(state.dir, 'agent.cjs');
// A real child process, with no provider, network, tools or real credentials.
writeFileSync(peer, String.raw`
const readline = require('node:readline');
const label = process.argv[2];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  let result = {};
  if (r.method === 'initialize') result = {protocolVersion:1};
  if (r.method === 'session/new') result = {sessionId:'fixture', configOptions: label === 'default' ? [] : [{id:'model', type:'select', currentValue:label, options:[{value:label}]}]};
  if (r.method === 'session/prompt') {
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({label,key:process.env.OPENROUTER_API_KEY || null})}}}});
    result = {stopReason:'end_turn'};
    setTimeout(() => process.exit(0), 20);
  }
  if (r.id != null) send({jsonrpc:'2.0',id:r.id,result});
});
// Bound even a failed assertion's child lifetime.
setTimeout(() => process.exit(0), 3000).unref();
`);
function connect(label: string, useOpenRouter = false) {
  saveLocalAcpConnection({ name: label, command: process.execPath, args: [peer, label], useOpenRouter });
}
beforeEach(() => { vi.stubEnv('O8_ACP_COMMAND', ''); vi.stubEnv('OPENROUTER_API_KEY', 'fixture-old'); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });

it('replaces cached models when the configured agent changes, including optional enumeration', async () => {
  connect('first');
  const first = localAcpProcessLaunch()!;
  expect((await probeAcpModels('acp', first, state.dir)).models[0].value).toBe('first');
  connect('second');
  // An older in-flight probe may complete after save; its fingerprint cannot poison B.
  await probeAcpModels('acp', first, state.dir, { force: true });
  expect((await probeAcpModels('acp', localAcpProcessLaunch()!, state.dir)).models[0].value).toBe('second');
  connect('default');
  expect((await probeAcpModels('acp', localAcpProcessLaunch()!, state.dir)).models).toEqual([]);
});

it('refreshes an unused child after the connection changes and excludes unchecked credentials', async () => {
  connect('first');
  acpBackend.ensureSession(state.dir, 'default', 'connection-change');
  connect('second');
  const events: OrchestratorEvent[] = [];
  await acpBackend.sendTurn(state.dir, 'fixture', event => events.push(event), { threadId: 'connection-change' });
  expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: JSON.stringify({ label: 'second', key: null }) }]);
  expect(events.some(event => event.type === 'done')).toBe(true);
});

it('uses the latest opted-in key when hydration happened after ensureSession but before sendTurn', async () => {
  connect('default', true);
  acpBackend.ensureSession(state.dir, 'default', 'key-change');
  vi.stubEnv('OPENROUTER_API_KEY', 'fixture-new');
  const events: OrchestratorEvent[] = [];
  await acpBackend.sendTurn(state.dir, 'fixture', event => events.push(event), { threadId: 'key-change' });
  expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: JSON.stringify({ label: 'default', key: 'fixture-new' }) }]);
  expect(events.some(event => event.type === 'done')).toBe(true);
});
