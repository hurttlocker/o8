/** @jsxImportSource @gpuix/react */
import React from 'react';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { render, flushSync, createRenderer, startFrameLoop } from '@gpuix/react';
import { createTestRoot } from '@gpuix/react/testing';
import { Native, api, state } from './native';
import { fixture } from './fixture';
import { createHash } from 'node:crypto';

const terminal = process.env.GPUIX_TERMINAL === '1';
const started = performance.now();
// Even the offscreen test window has a hard lifetime bound. No activation call.
const watchdog = setTimeout(() => process.exit(124), terminal ? 120000 : 9500);
const fixtureHash = createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const root = terminal ? null : createTestRoot({ width: 1200, height: 816 });
const live = terminal ? { renderer: createRenderer() } : null;
if (live) {
  live.renderer.init({ terminal: true, focus: false });
  render(<Native />, { renderer: live.renderer });
  startFrameLoop(live.renderer);
}
root?.render(<Native />);
// Frame-completion callback is inside this process. A test flush runs GPUI until
// parked; a live terminal frame is acknowledged by its draw counter. Neither
// timestamp asserts that a display presented the frame.
async function onFrame(action: () => void) {
  const t0 = performance.now();
  if (root) {
    flushSync(action);
    root.renderer.flush();
    root.renderer.dispatchNativeEvents();
    root.renderer.flush();
    root.renderer.dispatchNativeEvents();
  } else {
    const before = live!.renderer.getDebugFrameOverlayStats!().frames;
    flushSync(action);
    const deadline = performance.now() + 3000;
    live!.renderer.tick();
    while (live!.renderer.getDebugFrameOverlayStats!().frames <= before) {
      if (performance.now() > deadline) throw Error('Terminal frame callback timed out');
      await delay(1);
      live!.renderer.tick();
    }
  }
  return { elapsedMs: performance.now() - t0,
    drawMs: (root ? root.renderer : live!.renderer).getDebugFrameOverlayStats!().currentMs };
}
async function key() {
  const id = api.composer!();
  const previous = state.input;
  const result = await onFrame(() => {
    if (root) root.renderer.nativeSimulateKeystrokes(id, 'w');
    else { live!.renderer.focusElement!(id); live!.renderer.simulateKeystrokes!('w'); }
  });
  if (state.input !== previous + 'w') throw Error(`Input acknowledgement mismatch: ${state.input.length}`);
  if (root && !root.renderer.getPaintedText().includes(state.input)) throw Error('Input missing from painted text');
  return result;
}
async function run() {
  await delay(10);
  await onFrame(() => api.scroll!(1999));
  const stream = [], keys = [], scroll = [];
  const streamStart = performance.now();
  for (let n = 1; n <= 80; n++) {
    await delay(Math.max(0, streamStart + n * 20 - performance.now()));
    stream.push(await onFrame(() => api.stream!(n)));
    if (n % 4 === 0) keys.push(await key());
  }
  const streamMs = performance.now() - streamStart;
  for (let n = 0; n < 2000; n += 20) {
    scroll.push(await onFrame(() => api.scroll!(Math.min(n + 19, 1999))));
    await delay(0);
  }
  const result = { surface: 'native', fixtureHash, rows: fixture.length, width: 1200, height: 816,
    stream, keys, scroll, inputAcknowledged: state.input.length, tokens: state.tokens,
    streamMs, tokensPerSecond: 80 / (streamMs / 1000), ranges: state.ranges,
    processMs: performance.now() - started, measurement: 'GPUI test flush to in-process frame callback; no presentation' };
  writeFileSync(process.env.BENCH_RESULT!, JSON.stringify(result, null, 2));
  root?.unmount(); clearTimeout(watchdog); process.exit(0);
}
if (!terminal) void run().catch(error => { console.error(error); process.exit(1); });
else {
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const command = JSON.parse(body);
      let result: unknown;
      if (command.action === 'state') result = { ...state, size: live!.renderer.getWindowSize!(), fixtureHash, paintedInput: live!.renderer.getPaintedText!().includes(state.input) };
      else if (command.action === 'focus') {
        live!.renderer.focusElement(api.composer!());
        live!.renderer.tick();
        result = true;
      }
      else if (command.action === 'stream') result = await onFrame(() => api.stream!(command.n));
      else if (command.action === 'scroll') result = await onFrame(() => api.scroll!(command.n));
      else throw Error('Unknown benchmark command');
      response.end(JSON.stringify({ result }));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, '127.0.0.1', () => writeFileSync(process.env.BENCH_READY_FILE!, JSON.stringify({ port: (server.address() as { port: number }).port })));
}
