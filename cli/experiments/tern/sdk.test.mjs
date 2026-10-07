import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import { buildPacketInfoSurface } from './.build/src/commands/packet/info-surface.js';
import { formatHumanSemanticSurface } from './.build/src/presentation/format.js';
import { parsePacketPayload } from './demo.mjs';
import { presentSurface, toTspView } from './renderer.mjs';

let sdk, importError;
try { sdk = await import('@stencil-hq/tern'); } catch (error) { importError = error; }
const required = process.env.TERN_REQUIRE_SDK === '1';
test('official SDK is required in CI, never silently skipped', { skip: !required && !sdk ? 'SDK is not installed; local adapter tests are separate' : false }, () => {
  assert.ok(sdk, String(importError));
});
const protocolTest = (name, fn) => test(name, { skip: sdk ? false : 'official SDK unavailable; NOT protocol evidence' }, fn);
const fixture = JSON.parse(await readFile(new URL('./packet.fixture.json', import.meta.url), 'utf8'));
const model = () => buildPacketInfoSurface(parsePacketPayload(fixture));
const APC = '\x1b_tsp;', ST = '\x1b\\', DA1 = '\x1b[?1;2c';
const hello = {
  r: 'hello', v: 1, term: 'tern', ver: 'fixture',
  kinds: ['col', 'text', 'kv', 'table'], features: ['flow'],
  credits: 1, apc: 65536, cols: 100, cell: { w: 8, h: 16 },
  dark: true, reduceMotion: false,
};

/** Independent fake terminal peer; no closed-beta software or production wire fork. */
class Peer extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes = [];
  chunks = [];
  constructor(mode = 'supported', capabilities = {}) {
    super();
    this.output = {
      isTTY: true, columns: 100,
      write: bytes => {
        const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
        if (mode === 'frame-loss' && text.includes(`${APC}f;`)) throw Error('simulated TSP transport loss');
        this.chunks.push(text);
        if (text.includes(`${APC}q;`)) queueMicrotask(() => {
          if (mode === 'silent') return;
          if (mode === 'ordinary' || mode === 'native-disabled') { this.emit('data', DA1); return; }
          const body = mode === 'malformed' ? '{not-json' : JSON.stringify({ ...hello, ...capabilities });
          const reply = `${APC}r;${body}${ST}`;
          if (mode === 'fragmented') {
            const bytes = Buffer.from(reply);
            for (let i = 0; i < bytes.length; i += 7) this.emit('data', bytes.subarray(i, i + 7));
          } else this.emit('data', reply);
          this.emit('data', DA1);
        });
      },
    };
  }
  setRawMode(value) { this.isRaw = value; this.rawModes.push(value); }
  resume() {}
  pause() {}
  event(body) { this.emit('data', `${APC}e;${JSON.stringify(body)}${ST}`); }
  messages(verb) {
    return [...this.chunks.join('').matchAll(/\x1b_tsp;([a-z]);([\s\S]*?)\x1b\\/g)]
      .filter(match => !verb || match[1] === verb)
      .map(match => ({ verb: match[1], body: JSON.parse(match[2]) }));
  }
  options() { return { input: this, output: this.output, env: {}, timeout: 10, loadSdk: async () => sdk }; }
  restored() { assert.equal(this.isRaw, false); assert.equal(this.listenerCount('data'), 0); }
}

for (const mode of ['supported', 'fragmented']) protocolTest(`real SDK handshake and static output: ${mode}`, async () => {
  const peer = new Peer(mode);
  assert.equal((await presentSurface(model(), peer.options())).renderer, 'tsp');
  assert.equal(peer.messages('o')[0].body.listen, false);
  assert.equal(peer.messages('o')[0].body.mode, 'flow');
  assert.equal(peer.messages('f').length, 1);
  assert.equal(peer.messages('x').at(-1).body.keep, true);
  assert.deepEqual(peer.rawModes, [true, false]);
  peer.restored();
});
for (const mode of ['ordinary', 'native-disabled', 'silent', 'malformed']) protocolTest(`real SDK restores tty then falls back: ${mode}`, async () => {
  const peer = new Peer(mode);
  assert.equal((await presentSurface(model(), peer.options())).renderer, 'text');
  assert.equal(peer.messages('o').length, 0);
  assert.equal(peer.chunks.at(-1), formatHumanSemanticSurface(model()));
  peer.restored();
});
protocolTest('real SDK capability mismatch opens no surface', async () => {
  const peer = new Peer('supported', { features: [] });
  assert.equal((await presentSurface(model(), peer.options())).reason, 'unsupported-capability');
  assert.equal(peer.messages('o').length, 0);
  peer.restored();
});
protocolTest('actual SDK nodes and plain renderer preserve semantic information', () => {
  const normalize = text => text.split('\n').map(line => line.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(normalize(sdk.plain(toTspView(sdk, model()))), normalize(formatHumanSemanticSurface(model())));
});
protocolTest('TSP frame write loss attempts removal and recovers ordinary text', async () => {
  const peer = new Peer('frame-loss');
  assert.equal((await presentSurface(model(), peer.options())).renderer, 'text');
  assert.equal(peer.chunks.at(-1), formatHumanSemanticSurface(model()));
  assert.equal(peer.messages('x').at(-1).body.keep, false);
  peer.restored();
});
protocolTest('canonical SDK coalesces 1000 updates to the newest view under one credit', async () => {
  const peer = new Peer();
  const session = await sdk.connect({ ...peer.options(), app: 'o8-flow-control-proof', bracketedPaste: false, kittyKeyboard: false, exitHooks: false });
  assert.ok(session);
  try {
    const surface = session.open({ id: 'credit-proof', mode: 'flow' });
    for (let i = 0; i < 1000; i++) surface.render(sdk.ui.text({ key: 'value' }, `revision-${i}`));
    assert.equal(peer.messages('f').length, 1);
    peer.event({ ev: 'ack', sf: 'credit-proof', s: 1 });
    await tick();
    const frames = peer.messages('f');
    assert.equal(frames.length, 2);
    assert.match(JSON.stringify(frames[1].body), /revision-999/);
  } finally { await session.close(); }
  peer.restored();
});
