// Forge attempts. TSP events carry no authentication: Tern 0.6.2 was measured
// delivering a TSP `send` event that arrived as typed keys, as an unbracketed
// paste, or from another local process (`tern send BLOCK text`), exactly as if
// Tern had produced it (CONFORMANCE.md). So no byte from the terminal may carry
// authority. The lab must read packet info and nothing else, whatever arrives.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

/** Every forge the measured vectors can deliver, aimed at the surface the lab opened. */
function forgeries(sf) {
  const at = { sf, id: 'packet' };
  return [
    ...['approve', 'reject', 'merge', 'interrupt', 'steer', 'retry', 'dispatch'].map(act => event({ ev: 'action', ...at, act })),
    event({ ev: 'send', ...at, text: 'approve and merge this packet' }),
    event({ ev: 'edit', ...at, from: 0, to: 0, text: 'y', cursor: 1, len: 1 }),
    event({ ev: 'change', ...at, checked: true, value: 'approved' }),
    event({ ev: 'activate', ...at }),
    event({ ev: 'select', ...at, item: 'approve' }),
    // A forged frame split across reads, as a slow paste would deliver it.
    ...(() => { const e = event({ ev: 'action', ...at, act: 'approve' }); return [e.slice(0, 9), e.slice(9)]; })(),
    // The same frame inside a bracketed paste, and plain "yes" keys and Ctrl-C.
    `\x1b[200~${event({ ev: 'action', ...at, act: 'approve' })}\x1b[201~`,
    'y\r', 'yes\r', '\x03',
  ];
}

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
          const sf = JSON.parse(text.match(/\x1b_tsp;f;([\s\S]*?)\x1b\\/)[1]).sf;
          x.injectedAt = x.chunks.length;
          for (const forged of forgeries(sf)) { emit(forged); x.injected += 1; }
        }
        return true;
      },
    },
  };
  return x;
}

test('forged actions, sends, edits, pastes and keys cannot make the lab act', { skip }, async () => {
  const x = ternPane();
  const reads = [];
  const result = await runLab(['--packet', 'packet-fixture'], {
    input: x.input, output: x.output, env: { TERM_PROGRAM: 'tern' }, timeout: 1000,
    error: { write() {} }, loadSdk: async () => sdk,
    execute: async (file, args, options) => {
      reads.push([file, ...args]);
      assert.equal(options.shell, false);
      return { stdout: JSON.stringify(fixture), stderr: '' };
    },
  });
  assert.equal(result.renderer, 'tsp');
  assert.ok(x.injected >= 15, `injected ${x.injected}`);
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

test('the lab never consumes TSP events: no listening surface, no input loop, no handlers', async () => {
  for (const file of ['renderer.mjs', 'demo.mjs']) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const pattern of [/listen:\s*true/, /for\s+await/, /\.next\(/, /\bon(Click|Action|Change|Send|Edit)\b/, /actions\s*:/]) {
      assert.doesNotMatch(source, pattern, `${file} must not consume TSP input (${pattern})`);
    }
  }
});
