import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn, type IPty } from 'node-pty';
import { Terminal } from '@xterm/headless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Actual bundled CLI + PTY + socket transport. The provider is a deterministic
// fixture; live provider execution is a separate manual acceptance receipt.
const root = process.cwd();
const fixture = mkdtempSync(join(tmpdir(), 'o8-cli-chat-'));
const historyFile = join(fixture, 'thread.json');
const token = 'fixture-chat-operator-token';
const received: Record<string, unknown>[] = [];
const children = new Set<IPty>();
let threadId = '';
let socket: WebSocket | undefined;
let port: number;
let seq = 0;
let afterSubscribe: (() => void) | undefined;
let holdNextHistory = false;
let heldHistory: { response: ServerResponse; body: Buffer } | undefined;
const http = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401); response.end('{}'); return;
  }
  response.setHeader('content-type', 'application/json');
  if (request.url?.startsWith('/api/setup/agent')) {
    response.end(JSON.stringify({ choices: { orchestratorBackend: { value: 'codex' }, orchestratorModel: { value: 'fixture-model' } } }));
  } else {
    if (holdNextHistory) {
      holdNextHistory = false;
      heldHistory = { response, body: readFileSync(historyFile) };
      return;
    }
    try { response.end(readFileSync(historyFile)); }
    catch { response.end(JSON.stringify({ messages: [] })); }
  }
});
const ws = new WebSocketServer({ server: http });
const send = (event: string, data: Record<string, unknown>) => socket?.send(JSON.stringify({
  channel: 'orchestrator', event, seq: ++seq,
  data: { repoPath: root, threadId, backend: 'codex', ...data },
}));
ws.on('connection', (client, request) => {
  if (new URL(request.url!, 'http://localhost').searchParams.get('token') !== token) { client.close(); return; }
  socket = client;
  client.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    received.push(message);
    threadId = String(message.threadId);
    if (message.type === 'orchestrator-subscribe') {
      afterSubscribe?.();
      send('status', { status: 'ready', snapshot: true });
    } else if (message.type === 'orchestrator-send') {
      const persisted = { repoPath: root, backend: 'codex', model: 'fixture-model', messages: [
        { id: message.clientMessageId, role: 'user', content: message.displayMessage ?? message.message, attachments: message.attachments },
        { id: 'assistant-fixture', role: 'assistant', content: 'Saved answer: café 🌲' },
      ] };
      writeFileSync(historyFile, JSON.stringify(persisted));
      send('status', { status: 'busy' });
      send('output', { assistantMessageId: 'assistant-fixture', text: 'Saved answer: café 🌲' });
      // Deliberately repeat an event without advancing the replay cursor.
      client.send(JSON.stringify({ channel: 'orchestrator', event: 'output', seq,
        data: { repoPath: root, threadId, backend: 'codex', assistantMessageId: 'assistant-fixture', text: 'DUPLICATE' } }));
      send('output', { threadId: 'thoughts-unrelated', text: 'UNRELATED' });
      send('tool-use', { assistantMessageId: 'assistant-fixture', name: 'Read', toolUseId: 't1', args: { path: 'README.md' } });
      send('tool-result', { toolUseId: 't1', name: 'Read', output: 'fixture detail' });
      send('status', { status: 'ready' });
    } else if (message.type === 'orchestrator-interrupt') send('status', { status: 'ready' });
  });
});

async function until(predicate: () => boolean, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

function open(args: string[] = []) {
  const terminal = new Terminal({ cols: 90, rows: 28, allowProposedApi: true });
  // This child is an interactive terminal, not Ink's buffer-until-exit CI mode.
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1', O8_API_PORT: String(port),
    O8_WS_PORT: String(port), O8_API_TOKEN: token, CORTEX_IDE_DATA_DIR: fixture, CI: 'false', CONTINUOUS_INTEGRATION: 'false' };
  delete env.O8_WORKER_PACKET_ID;
  delete env.FORCE_COLOR;
  const child = spawn(process.execPath, [join(root, 'cli/dist/o8.mjs'), 'chat', '--no-motion', '--repo', root, ...args], {
    cwd: root, cols: 90, rows: 28, name: 'xterm-256color', env,
  });
  children.add(child);
  let raw = '';
  let exited = false;
  child.onData((data) => { raw += data; terminal.write(data); });
  child.onExit(() => { exited = true; children.delete(child); });
  const screen = () => Array.from({ length: terminal.rows }, (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? '').join('\n');
  return { child, terminal, screen, raw: () => raw, exited: () => exited };
}

beforeAll(async () => {
  execFileSync(process.execPath, ['cli/esbuild.config.mjs'], { cwd: root, timeout: 30_000, stdio: 'pipe' });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  port = address.port;
});
afterAll(async () => {
  for (const child of children) child.kill();
  for (const client of ws.clients) client.terminate();
  await new Promise<void>((resolve) => ws.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
  rmSync(fixture, { recursive: true, force: true });
});

describe('bundled terminal conversation', () => {
  it('keeps command mode noninteractive and validates options before connecting', () => {
    const help = spawnSync(process.execPath, ['cli/dist/o8.mjs', 'chat', '--help'], { cwd: root, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Ctrl+J');
    const piped = spawnSync(process.execPath, ['cli/dist/o8.mjs', 'chat'], { cwd: root, encoding: 'utf8' });
    expect(piped.status).toBe(1);
    expect(piped.stderr).toContain('terminal_required');
    const json = spawnSync(process.execPath, ['cli/dist/o8.mjs', '--json'], { cwd: root, encoding: 'utf8' });
    expect(json.stdout).not.toContain('\x1b[?1049h');
  });

  it('handles real PTY paste, sending, tool expansion, resize, disconnect, and persisted resume', async () => {
    const app = open();
    await until(() => app.screen().includes('connected') && !app.screen().includes('connecting'), 'connected screen').catch((error) => { throw new Error(`${error.message}\n${app.screen()}\n${app.raw().slice(-2000)}`); });
    const sentBefore = received.filter((event) => event.type === 'orchestrator-send').length;
    app.child.write('\x1b[200~first line\nsecond 👩🏽‍💻\x1b[201~');
    await until(() => app.screen().includes('second'), 'pasted composer');
    expect(received.filter((event) => event.type === 'orchestrator-send')).toHaveLength(sentBefore);
    app.child.write('\r');
    await until(() => app.screen().includes('Saved answer') && app.screen().includes('Ready'), 'streamed and saved answer');
    const sent = received.find((event) => event.type === 'orchestrator-send')!;
    expect(sent.message).toBe('first line\nsecond 👩🏽‍💻');
    expect(sent.permissionMode).toBe('plan');
    expect(app.screen()).not.toMatch(/DUPLICATE|UNRELATED/);
    expect(JSON.parse(readFileSync(historyFile, 'utf8')).messages).toHaveLength(2);
    app.child.write('\x0f');
    await until(() => app.screen().includes('fixture detail'), 'expanded tool output');
    app.terminal.resize(48, 22); app.child.resize(48, 22);
    await until(() => app.screen().includes('Ctrl+J'), 'narrow composer');
    expect(app.screen()).toContain('Saved answer');
    socket!.close();
    await until(() => app.screen().includes('disconnected'), 'disconnection state');
    expect(app.raw()).not.toContain(token);
    expect(app.raw()).not.toMatch(/\x1b\[(?:38|48);/);
    app.child.write('/quit'); await new Promise((resolve) => setTimeout(resolve, 60)); app.child.write('\r');
    await until(app.exited, 'clean exit');
    expect(app.raw()).toContain('\x1b[?2004l');
    expect(app.raw()).toContain('\x1b[?1049l');
    app.terminal.dispose();

    const resumed = open(['--resume', threadId]);
    await until(() => resumed.screen().includes('Saved answer'), 'persisted conversation after restart');
    expect(received.filter((event) => event.type === 'orchestrator-send')).toHaveLength(sentBefore + 1);
    resumed.child.write('/quit'); await new Promise((resolve) => setTimeout(resolve, 60)); resumed.child.write('\r');
    await until(resumed.exited, 'resumed clean exit');
    resumed.terminal.dispose();
  });

  it('stages dropped images and text, removes files, and sends bytes through the real socket only on Enter', async () => {
    const image = join(fixture, 'tiny image.png');
    const note = join(fixture, 'note.txt');
    const binary = join(fixture, 'binary.dat');
    const oversized = join(fixture, 'oversized.txt');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
    writeFileSync(image, png); writeFileSync(note, 'Exact café file contents');
    writeFileSync(binary, Buffer.from([0, 255])); writeFileSync(oversized, 'a'.repeat(262145));
    const app = open();
    await until(() => app.screen().includes('● connected'), 'attachment connection');
    const before = received.filter((event) => event.type === 'orchestrator-send').length;
    const command = async (value: string) => {
      app.child.write(value); await new Promise((resolve) => setTimeout(resolve, 80)); app.child.write('\r');
    };
    app.child.write(`\x1b[200~'${image}' '${note}'\x1b[201~`);
    await until(() => app.screen().includes('Attachments ready') && app.screen().includes('2. File'), 'staged files');
    expect(received.filter((event) => event.type === 'orchestrator-send')).toHaveLength(before);
    await command(`/attach '${binary}'`);
    await until(() => app.screen().includes('file is binary'), 'binary refusal');
    expect(app.screen()).toContain('tiny image.png');
    await command(`/attach '${oversized}'`);
    await until(() => app.screen().includes('at most 256 KiB'), 'oversize refusal');
    await command('/remove 2');
    await until(() => app.screen().includes('Attachment removed'), 'remove text file');
    expect(app.screen()).not.toContain('2. File');
    await command(`/attach '${note}'`);
    await until(() => app.screen().includes('2. File'), 'reattach text file');
    await command('Review these files');
    await until(() => received.filter((event) => event.type === 'orchestrator-send').length === before + 1 && app.screen().includes('Ready'), 'attachment send');
    const sent = received.filter((event) => event.type === 'orchestrator-send').at(-1)!;
    expect(sent.displayMessage).toBe('Review these files\n[Image: tiny image.png]\n[File: note.txt]');
    expect(sent.message).toContain('Exact café file contents');
    expect(sent.attachments).toEqual([{ name: 'tiny image.png', dataUri: `data:image/png;base64,${png.toString('base64')}` }]);
    const saved = JSON.parse(readFileSync(historyFile, 'utf8'));
    expect(saved.messages[0].content).toBe(sent.displayMessage);
    expect(saved.messages[0].attachments).toEqual(sent.attachments);
    await command('/quit'); await until(app.exited, 'attachment exit'); app.terminal.dispose();
  });

  it('pins the prompt, holds wheel scroll during streaming, and returns to latest', async () => {
    writeFileSync(historyFile, JSON.stringify({ repoPath: root, backend: 'codex', model: 'fixture-model', messages: [
      { id: 'prompt', role: 'user', content: 'Keep this task in view' },
      { id: 'long-answer', role: 'assistant', content: Array.from({ length: 60 }, (_, i) => `Answer row ${i}`).join('\n') },
    ] }));
    const app = open(['--resume', 'thoughts-scroll']);
    await until(() => app.screen().includes('Answer row 59') && app.screen().includes('● connected'), 'long saved response');
    expect(app.screen()).toContain('› Keep this task in view');
    app.child.write('\x1b[<64;10;5M\x1b[<64;10;5M');
    await until(() => app.screen().includes('Reading earlier'), 'wheel scroll');
    const visibleAnswer = () => app.screen().split('\n').filter((line) => /Answer row|Keep this task/.test(line));
    const held = visibleAnswer();
    send('output', { assistantMessageId: 'long-answer', text: '\nNEW END\n' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(visibleAnswer()).toEqual(held);
    app.child.write('\x07');
    await until(() => app.screen().includes('NEW END'), 'return to latest');
    for (let index = 0; index < 6; index += 1) {
      app.child.write('\x1b[5~'); await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await until(() => app.screen().includes('›  You'), 'full prompt revealed');
    expect(app.screen()).not.toContain('› Keep this task in view');
    app.child.write('/quit'); await new Promise((resolve) => setTimeout(resolve, 80)); app.child.write('\r');
    await until(app.exited, 'scroll exit');
    expect(app.raw()).toContain('\x1b[?1006l\x1b[?1000l');
    app.terminal.dispose();
  });

  it('refreshes a ready snapshot after resume and preserves stored agent routing', async () => {
    const stored = { repoPath: root, backend: 'codex', agent: 'stored-agent', model: 'fixture-model',
      messages: [{ id: 'earlier', role: 'assistant', content: 'Earlier saved response' }] };
    writeFileSync(historyFile, JSON.stringify(stored));
    afterSubscribe = () => {
      // The turn finishes between the initial HTTP read and WS subscription.
      writeFileSync(historyFile, JSON.stringify({ ...stored, messages: [
        ...stored.messages, { id: 'finished', role: 'assistant', content: 'Finished during attachment' },
      ] }));
    };
    const app = open(['--resume', 'thoughts-resume-race']);
    await until(() => app.screen().includes('Finished during attachment'), 'ready snapshot reconciliation');
    expect(received.at(-1)).toMatchObject({ type: 'orchestrator-subscribe', agent: 'stored-agent' });
    expect(received.at(-1)).not.toHaveProperty('since');
    app.child.write('next'); await new Promise((resolve) => setTimeout(resolve, 60)); app.child.write('\r');
    await until(() => app.screen().includes('Saved answer'), 'resumed send');
    expect(received.at(-1)).toMatchObject({ type: 'orchestrator-send', agent: 'stored-agent' });
    send('status', { status: 'busy' });
    await until(() => app.screen().includes('Esc stop'), 'busy turn');
    app.child.write('\x1b');
    await until(() => received.at(-1)?.type === 'orchestrator-interrupt', 'interrupt routed agent');
    expect(received.at(-1)).toMatchObject({ agent: 'stored-agent' });
    app.child.write('/quit'); await new Promise((resolve) => setTimeout(resolve, 60)); app.child.write('\r');
    await until(app.exited, 'resume race exit');
    afterSubscribe = undefined;
    app.terminal.dispose();
  });

  it('does not overwrite a newer turn with a delayed attachment history response', async () => {
    writeFileSync(historyFile, JSON.stringify({ repoPath: root, backend: 'codex', model: 'fixture-model',
      messages: [{ id: 'old', role: 'assistant', content: 'Old attachment response' }] }));
    afterSubscribe = () => { holdNextHistory = true; };
    const app = open(['--resume', 'thoughts-delayed-history']);
    await until(() => Boolean(heldHistory) && app.screen().includes('● connected'), 'delayed history request');
    app.child.write('new turn'); await new Promise((resolve) => setTimeout(resolve, 60)); app.child.write('\r');
    await until(() => app.screen().includes('Saved answer'), 'newer completed response');
    heldHistory!.response.end(heldHistory!.body);
    heldHistory = undefined;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(app.screen()).toContain('Saved answer');
    expect(app.screen()).not.toContain('Old attachment response');
    app.child.write('/quit'); await new Promise((resolve) => setTimeout(resolve, 60)); app.child.write('\r');
    await until(app.exited, 'delayed history exit');
    afterSubscribe = undefined;
    app.terminal.dispose();
  });
});
