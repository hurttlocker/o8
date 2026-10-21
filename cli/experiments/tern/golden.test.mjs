// Byte-identical fallback: every terminal without Tern gets exactly today's
// `o8 packet info` bytes (the goldens are rendered by the real CLI renderer in
// cli/src/presentation/text.golden.test.ts), and the same screen in a headless
// terminal. Profiles marked "measured" match the conformance receipts in
// CONFORMANCE.md.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import xterm from '@xterm/headless';
import { runLab } from './demo.mjs';

let sdk;
try { sdk = await import('@stencil-hq/tern'); } catch { sdk = null; }
const golden = {
  plain: await readFile(new URL('./golden/packet-info.plain.txt', import.meta.url), 'utf8'),
  tty: await readFile(new URL('./golden/packet-info.tty.txt', import.meta.url), 'utf8'),
};

/** A tty the lab writes to; it records raw-mode changes and every byte. */
function tty(env, { isTTY = true, reply } = {}) {
  const listeners = new Set();
  const x = {
    rawModes: [], chunks: [], env,
    input: {
      isTTY, isRaw: false,
      setRawMode(value) { x.input.isRaw = value; x.rawModes.push(value); },
      on(_, fn) { listeners.add(fn); }, off(_, fn) { listeners.delete(fn); },
      resume() {}, pause() {},
    },
    output: {
      isTTY, columns: 100,
      write(bytes) {
        const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
        x.chunks.push(text);
        if (reply && text.includes('\x1b[c')) queueMicrotask(() => { for (const fn of listeners) fn(reply); });
        return true;
      },
    },
  };
  return x;
}

/** What a viewer sees: text and bold cells, after the tty's ONLCR. */
async function screen(bytes) {
  const term = new xterm.Terminal({ cols: 100, rows: 40, allowProposedApi: true });
  await new Promise(resolve => term.write(bytes.replaceAll('\n', '\r\n'), resolve));
  const rows = [];
  const buffer = term.buffer.active;
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    let text = '', bold = '';
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      text += cell.getChars() || ' ';
      bold += cell.isBold() ? 'B' : '.';
    }
    rows.push(`${text.trimEnd()}|${bold.slice(0, text.trimEnd().length)}`);
  }
  term.dispose();
  while (rows.at(-1) === '|') rows.pop();
  return rows;
}

const profiles = {
  'Terminal.app (measured)': { TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' },
  'iTerm2': { TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' },
  'Ghostty': { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' },
  'tmux, with or without Tern underneath (measured)': { TERM_PROGRAM: 'tmux', TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%0' },
  'SSH from a Tern pane, no opt-in (measured)': { SSH_TTY: '/dev/pts/0', TERM: 'xterm-kitty' },
  'Tern with TERN_TSP=0': { TERM_PROGRAM: 'tern', TERN_TSP: '0' },
  'CI with a pty': { CI: 'true', TERM: 'dumb' },
};

for (const [name, env] of Object.entries(profiles)) {
  test(`${name}: today's bytes and screen, no probe, no raw mode`, async () => {
    const x = tty(env);
    let loads = 0;  // A throwing loadSdk would be swallowed as sdk-unavailable; count instead.
    const result = await runLab(['--fixture'], { ...x, loadSdk: async () => { loads += 1; return sdk; } });
    assert.equal(loads, 0);
    assert.equal(result.renderer, 'text');
    assert.equal(x.chunks.join(''), golden.tty);
    assert.deepEqual(x.rawModes, []);
    assert.deepEqual(await screen(x.chunks.join('')), await screen(golden.tty));
  });
}

test('pipe, including CI without a tty: plain golden bytes', async () => {
  const x = tty({ TERM_PROGRAM: 'tern' }, { isTTY: false });
  let loads = 0;
  await runLab(['--fixture'], { ...x, loadSdk: async () => { loads += 1; return sdk; } });
  assert.equal(loads, 0);
  assert.equal(x.chunks.join(''), golden.plain);
});

// Control: the check must be able to fail. Terminal.app was measured printing an
// unknown APC payload as text and answering DA1 with ESC [ ? 1 ; 2 c. Forcing the
// probe there (TERN_TSP=1) must produce a different screen than the golden.
const appleTerminal = bytes => bytes.replace(/\x1b_([\s\S]*?)\x1b\\/g, '$1');
test('control: a forced probe in Terminal.app leaks the hello and fails the screen check', {
  skip: sdk ? false : 'official SDK unavailable',
}, async () => {
  const x = tty({ TERM_PROGRAM: 'Apple_Terminal', TERN_TSP: '1' }, { reply: '\x1b[?1;2c' });
  const result = await runLab(['--fixture'], { ...x, timeout: 200, loadSdk: async () => sdk });
  assert.equal(result.renderer, 'text');
  const seen = await screen(appleTerminal(x.chunks.join('')));
  assert.notDeepEqual(seen, await screen(golden.tty));
  assert.ok(seen.some(row => row.includes('tsp;q;{"q":"hello"')), seen.join('\n'));
});
