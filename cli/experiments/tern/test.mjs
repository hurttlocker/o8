import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildPacketInfoSurface } from './.build/src/commands/packet/info-surface.js';
import { formatHumanSemanticSurface } from './.build/src/presentation/format.js';
import { presentSurface, toTspView } from './renderer.mjs';
import { parsePacketPayload, runLab } from './demo.mjs';

const fixture = JSON.parse(await readFile(new URL('./packet.fixture.json', import.meta.url), 'utf8'));
const model = () => buildPacketInfoSurface(parsePacketPayload(fixture));
const expectedText = '\npacket\n' + [
  ['lane', 'lane-fixture'], ['packet', 'packet-fixture'], ['status', 'running'],
  ['runtime', 'pi'], ['actual runtime', '(pending)'], ['branch', 'lab/read-only'],
  ['base', 'main'], ['repo', '/example/o8'], ['worktree', '(none)'],
  ['label', 'SYNTHETIC FIXTURE — not live worker evidence'],
].map(([k, v]) => `${k.padEnd(14)}  ${v}\n`).join('') +
  '\nrecent events (1)\n  2026-10-07T00:00:00Z  fixture       observed\n';

function io() {
  const chunks = [], order = [];
  return {
    input: { isTTY: true, isRaw: false, setRawMode() {} }, env: {},
    output: { isTTY: true, write(text) { chunks.push(String(text)); order.push('text'); } },
    chunks, order,
  };
}
function fakeSdk(options = {}) {
  const calls = [];
  const builders = Object.fromEntries(['col', 'text', 'kv', 'table'].map(kind => [kind,
    (props, ...children) => ({ kind, props, children })]));
  const native = {
    render(view) { calls.push(['render', view]); if (options.renderError) throw Error('render failed'); },
    async close(opts) { calls.push(['surface.close', opts]); },
  };
  const session = {
    caps: { kinds: ['col', 'text', 'kv', 'table'], features: ['flow'], ...options.caps },
    open(opts) { calls.push(['open', opts]); return native; },
    async close() { calls.push(['session.close']); options.onClose?.(); if (options.closeError) throw Error('close failed'); },
  };
  const sdk = {
    ui: builders,
    async connect(opts) { calls.push(['connect', opts]); return options.noTsp ? null : session; },
  };
  return { sdk, calls };
}

test('S1 parity: byte-for-byte old non-TTY packet-info output, including unknowns', () => {
  assert.equal(formatHumanSemanticSurface(model()), expectedText);
  assert.equal(formatHumanSemanticSurface(model(), t => `<${t}>`).split('\n')[1], '<packet>');
});
test('stable IDs, no empty event block, and no input mutation', () => {
  const before = JSON.stringify(fixture);
  const empty = buildPacketInfoSurface({ ...parsePacketPayload(fixture), events: [] });
  assert.equal(empty.id, 'packet-info:lane-fixture');
  assert.equal(empty.blocks.length, 1);
  assert.equal(JSON.stringify(fixture), before);
});
for (const [name, mutate] of [
  ['piped output', x => { x.output.isTTY = false; }],
  ['piped input', x => { x.input.isTTY = false; }],
  ['already-owned raw input', x => { x.input.isRaw = true; }],
  ['opt-out', x => { x.env.TERN_TSP = '0'; }],
  ...['TMUX', 'STY', 'ZELLIJ'].map(key => [key, x => { x.env[key] = 'active'; }]),
]) test(`${name}: text without loading SDK or probing`, async () => {
  const x = io(); mutate(x);
  const result = await presentSurface(model(), { ...x, loadSdk() { assert.fail('must not load SDK'); } });
  assert.equal(result.renderer, 'text');
  assert.equal(x.chunks.join(''), expectedText);
});
test('missing SDK is a working text path', async () => {
  const x = io();
  const result = await presentSurface(model(), { ...x, loadSdk: async () => { throw Error('not installed'); } });
  assert.equal(result.reason, 'sdk-unavailable');
  assert.equal(x.chunks.join(''), expectedText);
});
test('no TSP after negotiation falls back exactly once', async () => {
  const x = io(), { sdk } = fakeSdk({ noTsp: true });
  assert.equal((await presentSurface(model(), { ...x, loadSdk: async () => sdk })).renderer, 'text');
  assert.deepEqual(x.chunks, [expectedText]);
});
for (const caps of [{ features: [] }, { kinds: ['col', 'text', 'kv'] }]) {
  test(`unsupported capabilities ${JSON.stringify(caps)} restore input before text`, async () => {
    const x = io(), { sdk, calls } = fakeSdk({ caps, onClose: () => x.order.push('close') });
    const result = await presentSurface(model(), { ...x, loadSdk: async () => sdk });
    assert.equal(result.reason, 'unsupported-capability');
    assert.equal(calls.some(([name]) => name === 'open'), false);
    assert.deepEqual(x.order, ['close', 'text']);
  });
}
test('static native output has no action handlers, uses flow and closes cleanly', async () => {
  const x = io(), { sdk, calls } = fakeSdk();
  assert.equal((await presentSurface(model(), { ...x, loadSdk: async () => sdk })).renderer, 'tsp');
  assert.deepEqual(calls.find(([name]) => name === 'open')[1], {
    id: model().id, mode: 'flow', listen: false, title: 'o8 packet',
  });
  assert.deepEqual(calls.slice(-2).map(([name]) => name), ['surface.close', 'session.close']);
  assert.equal(x.chunks.length, 0);
  const nodes = calls.find(([name]) => name === 'render')[1];
  assert.equal(JSON.stringify(nodes).includes('actions'), false);
  assert.deepEqual(calls[0][1].features, []);
  assert.equal(calls[0][1].bracketedPaste, false);
  assert.equal(calls[0][1].kittyKeyboard, false);
});
test('native projection preserves every fact and event in the same semantic order', () => {
  const { sdk } = fakeSdk();
  const view = toTspView(sdk, model());
  assert.deepEqual(view.children[0].children[1].props.items,
    model().blocks[0].facts.map(({ label: k, value: v }) => ({ k, v })));
  assert.deepEqual(view.children[1].children[1].props.rows,
    model().blocks[1].events.map(e => ({ id: e.id, cells: { timestamp: e.timestamp, actor: e.actor, verb: e.verb } })));
});
test('unused table capability is not required without event rows', async () => {
  const x = io(), { sdk } = fakeSdk({ caps: { kinds: ['col', 'text', 'kv'] } });
  const noEvents = buildPacketInfoSurface({ ...parsePacketPayload(fixture), events: [] });
  assert.equal((await presentSurface(noEvents, { ...x, loadSdk: async () => sdk })).renderer, 'tsp');
});
test('renderer failure discards partial native output and closes before fallback', async () => {
  const x = io(), { sdk, calls } = fakeSdk({ renderError: true, onClose: () => x.order.push('close') });
  assert.equal((await presentSurface(model(), { ...x, loadSdk: async () => sdk })).renderer, 'text');
  assert.deepEqual(calls.find(([name]) => name === 'surface.close')[1], { keep: false });
  assert.deepEqual(x.order, ['close', 'text']);
  assert.deepEqual(x.chunks, [expectedText]);
});
test('cleanup failure cannot produce a native-success receipt', async () => {
  const x = io(), { sdk } = fakeSdk({ closeError: true });
  assert.equal((await presentSurface(model(), { ...x, loadSdk: async () => sdk })).reason, 'cleanup-failed');
  assert.deepEqual(x.chunks, [expectedText]);
});
test('a broken plain stdout is a real error, not reported as successful fallback', async () => {
  const x = io(); x.output.isTTY = false; x.output.write = () => { throw Error('broken stdout'); };
  await assert.rejects(presentSurface(model(), x), /broken stdout/);
});
test('live command delegates only packet info JSON; no shell, dispatch or input forwarding', async () => {
  const x = io(); x.output.isTTY = false;
  const errors = [];
  await runLab(['--packet', 'packet-42'], {
    ...x, error: { write: s => errors.push(s) },
    execute: async (file, args, options) => {
      assert.equal(file, 'o8');
      assert.deepEqual(args, ['packet', 'info', 'packet-42', '--json']);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 15000);
      return { stdout: JSON.stringify(fixture), stderr: 'runtime evidence pending\n' };
    },
  });
  assert.deepEqual(errors, ['runtime evidence pending\n']);
  assert.equal(x.chunks.join(''), expectedText);
});
test('explicit JSON remains machine-readable and never loads SDK', async () => {
  const x = io();
  await runLab(['--fixture', '--json'], { ...x, loadSdk() { assert.fail('no SDK for JSON'); } });
  assert.deepEqual(JSON.parse(x.chunks.join('')), fixture);
});
test('fixture is explicitly synthetic and needs neither a running o8 nor SDK', async () => {
  const x = io();
  await runLab(['--fixture', '--text'], { ...x, execute() { assert.fail('no live call'); } });
  assert.match(x.chunks.join(''), /SYNTHETIC FIXTURE/);
});
for (const args of [['--dispatch'], ['--packet'], ['--packet', '--merge'], ['--fixture', '--packet', 'x'], ['--json', '--text']]) {
  test(`invalid args rejected before reading or probing: ${args.join(' ')}`, async () => {
    await assert.rejects(runLab(args, { execute() { assert.fail('no read'); } }), /argument|cannot|requires|Unknown/i);
  });
}
test('API/command failure is not converted into a healthy fixture', async () => {
  await assert.rejects(runLab([], { execute: async () => { throw Error('unauthorized'); } }), /unauthorized/);
});
test('bad schema or absent evidence fails instead of inventing facts', () => {
  assert.throws(() => parsePacketPayload({ schema: 'other', packet: fixture.packet }), /schema/);
  assert.throws(() => parsePacketPayload({ ...fixture, packet: { ...fixture.packet, actualRuntime: undefined } }), /actualRuntime/);
});
