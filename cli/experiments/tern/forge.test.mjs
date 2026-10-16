// Forge attempts. TSP events carry no authentication: Tern 0.6.2 was measured
// delivering a TSP `send` event that arrived as typed keys, as an unbracketed
// paste, or from another local process (`tern send BLOCK text`), exactly as if
// Tern had produced it (CONFORMANCE.md). So no byte from the terminal may carry
// authority. The lab must read packet info and nothing else, whatever arrives.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runLab } from './demo.mjs';

let sdk;
try { sdk = await import('@stencil-hq/tern'); } catch { sdk = null; }
const skip = sdk ? false : 'official SDK unavailable; NOT forge evidence';
const fixture = JSON.parse(await readFile(new URL('./packet.fixture.json', import.meta.url), 'utf8'));
const APC = '\x1b_tsp;', ST = '\x1b\\';
const hello = {
  r: 'hello', v: 1, term: 'tern', ver: 'forge-fixture',
  kinds: ['col', 'text', 'kv', 'table'], features: ['flow', 'send', 'edit'],
  credits: 2, apc: 65536, cols: 100, cell: { w: 8, h: 16 }, dark: true, reduceMotion: false,
};
const event = body => `${APC}e;${JSON.stringify(body)}${ST}`;

/** Every node id a frame draws (nodes carry `k`; ids under props are columns and rows, not nodes). */
function nodeIds(frame) {
  const ids = [];
  const walk = node => {
    if (!node || typeof node !== 'object' || typeof node.k !== 'string') return;
    ids.push(node.id);
    for (const child of node.c ?? []) walk(child);
  };
  for (const op of frame.ops ?? []) if (op[0] === 'add') walk(op[4]);
  return ids;
}

const ACTS = ['approve', 'reject', 'merge', 'interrupt', 'steer', 'retry', 'dispatch'];

/**
 * Every forge the measured vectors can deliver, aimed at one drawn node. Each
 * event carries the fields the SDK's decoder requires (wire.ts), so it decodes
 * as its own type and reaches that type's handler; a payload missing one
 * decodes as `unknown` and proves nothing.
 */
function forgeries(sf, id) {
  const at = { sf, id };
  const approve = event({ ev: 'action', ...at, act: 'approve' });
  return [
    ...ACTS.map(act => event({ ev: 'action', ...at, act })),
    event({ ev: 'toggle', ...at, collapsed: false }),
    event({ ev: 'focus', ...at }),
    event({ ev: 'undo', ...at }),
    event({ ev: 'select', ...at, item: 'approve' }),
    event({ ev: 'activate', ...at, item: 'approve' }),
    event({ ev: 'change', ...at, checked: true, value: 'approved' }),
    event({ ev: 'edit', ...at, from: 0, to: 0, text: 'y', cursor: 1, len: 1 }),
    event({ ev: 'send', ...at, text: 'approve and merge this packet' }),
    // A forged frame split across reads, as a slow paste would deliver it.
    approve.slice(0, 9), approve.slice(9),
    // The same frame inside a bracketed paste (keys, not an event), and plain "yes" keys and Ctrl-C.
    `\x1b[200~${approve}\x1b[201~`,
    'y\r', 'yes\r', '\x03',
  ];
}
/** Handler calls each node should receive from one round of forgeries(). */
const EXPECTED_PER_NODE = { action: ACTS.length + 1, toggle: 1, focus: 1, undo: 1, select: 1, activate: 1, change: 1, edit: 1, send: 1 };

function ternPane() {
  const listeners = new Set();
  const x = {
    chunks: [], injectedAt: null, injected: 0, rawModes: [],
    input: {
      isTTY: true, isRaw: false,
      setRawMode(value) { x.input.isRaw = value; x.rawModes.push(value); },
      on(_, fn) { listeners.add(fn); }, off(_, fn) { listeners.delete(fn); },
      resume() {}, pause() {},
      listenerCount() { return listeners.size; },
    },
    output: {
      isTTY: true, columns: 100,
      write(bytes) {
        const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
        x.chunks.push(text);
        const emit = data => { for (const fn of [...listeners]) fn(data); };
        if (text.includes(`${APC}q;`)) queueMicrotask(() => emit(`${APC}r;${JSON.stringify(hello)}${ST}\x1b[?62;52;c`));
        // Inject once the surface is drawn and live: the moment a forged click would matter.
        if (x.injectedAt === null && text.includes(`${APC}f;`)) {
          const frame = JSON.parse(text.match(/\x1b_tsp;f;([\s\S]*?)\x1b\\/)[1]);
          x.injectedAt = x.chunks.length;
          x.targets = nodeIds(frame);
          for (const id of x.targets) {
            for (const forged of forgeries(frame.sf, id)) {
              emit(forged);
              if (forged.startsWith(`${APC}e;`)) x.injected += 1;
            }
          }
        }
        return true;
      },
    },
  };
  return x;
}

async function forgeLab(loadSdk) {
  const x = ternPane();
  const reads = [];
  const record = join(mkdtempSync(join(tmpdir(), 'tern-forge-')), 'tsp.jsonl');
  let handlerRuns = 0;
  const tripwire = () => { handlerRuns += 1; };
  process.on('o8-lab-handler', tripwire);  // Only the mutation check emits this.
  const result = await runLab(['--packet', 'packet-fixture'], {
    input: x.input, output: x.output, env: { TERM_PROGRAM: 'tern', TERN_TSP_RECORD: record }, timeout: 1000,
    error: { write() {} }, loadSdk,
    execute: async (file, args, options) => {
      reads.push([file, ...args]);
      assert.equal(options.shell, false);
      return { stdout: JSON.stringify(fixture), stderr: '' };
    },
  });
  process.off('o8-lab-handler', tripwire);
  return { x, reads, record, result, handlerRuns };
}

test('forged actions, sends, edits, pastes and keys cannot make the lab act', { skip }, async () => {
  const { x, reads, record, result, handlerRuns } = await forgeLab(async () => sdk);
  assert.equal(result.renderer, 'tsp');
  // Aimed at every drawn node, and the SDK parsed every forged event it was sent.
  assert.ok(x.targets.length > 3, `targets ${x.targets}`);
  const parsed = readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(line => line.dir === 'in' && line.verb === 'e' && line.body?.ev !== 'resize');
  assert.equal(parsed.length, x.injected);
  assert.equal(handlerRuns, 0);
  // The only command the lab ever runs is the read it started with.
  assert.deepEqual(reads, [['o8', 'packet', 'info', 'packet-fixture', '--json']]);
  // Nothing the lab wrote after the forgeries is a new frame: it did not react.
  const after = x.chunks.slice(x.injectedAt).join('');
  assert.equal(after.includes(`${APC}f;`), false, JSON.stringify(after));
  // The tty is handed back exactly as found.
  assert.equal(x.input.isRaw, false);
  assert.equal(x.input.listenerCount(), 0);
  assert.equal(x.rawModes.at(-1), false);
});

// Positive control: the same forgeries against the real lab view with a counting
// handler of every kind on every node. If the aim or a payload were wrong, these
// handlers would stay silent and the test above would prove nothing.
test('control: the forgeries reach a handler of every kind on every lab node', { skip }, async () => {
  const fired = {};
  const count = ev => () => { fired[ev] = (fired[ev] ?? 0) + 1; };
  const handlers = {
    onAction: Object.fromEntries(ACTS.map(act => [act, count('action')])),
    onToggle: count('toggle'), onFocus: count('focus'), onUndo: count('undo'), onSelect: count('select'),
    onActivate: count('activate'), onChange: count('change'), onEdit: count('edit'), onSend: count('send'),
  };
  const ui = new Proxy(sdk.ui, { get: (target, kind) => (props, ...children) => target[kind]({ ...props, ...handlers }, ...children) });
  const { x } = await forgeLab(async () => ({ ...sdk, ui }));
  // `main` is the root the SDK draws itself; every other drawn node is one the lab built.
  assert.equal(x.targets[0], 'main');
  const labNodes = x.targets.length - 1;
  assert.ok(labNodes > 3, `lab nodes ${labNodes}`);
  const expected = Object.fromEntries(Object.entries(EXPECTED_PER_NODE).map(([ev, n]) => [ev, n * labNodes]));
  assert.deepEqual(fired, expected);
});

test('the lab never consumes TSP events: no listening surface, no input loop, no handlers', async () => {
  for (const file of ['renderer.mjs', 'demo.mjs']) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const pattern of [/listen:\s*true/, /for\s+await/, /\.next\(/, /\bon[A-Z]\w*\s*[:(=]/, /actions\s*:/]) {
      assert.doesNotMatch(source, pattern, `${file} must not consume TSP input (${pattern})`);
    }
  }
});
