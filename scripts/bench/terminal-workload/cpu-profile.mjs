import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

async function connectInspector(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('diagnostic inspector connection timed out'));
    }, 10000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  return {
    send: (method) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`diagnostic inspector ${method} timed out`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method }));
    }),
    close: () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('diagnostic inspector closed'));
      }
      pending.clear();
      socket.terminate();
    },
  };
}

// Diagnostic-only. The profiler changes scheduling and allocation, so receipts
// carrying these profiles are explicitly ineligible for budget acceptance.
export async function startCpuProfiles({ context, page, stack, directory, label }) {
  const urls = [...stack.logs.ws().matchAll(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/g)];
  const url = urls.at(-1)?.[1];
  if (!url) throw new Error('isolated realtime inspector endpoint was not published');
  const renderer = await context.newCDPSession(page);
  let realtime;
  try {
    realtime = await connectInspector(url);
    await Promise.all([renderer.send('Profiler.enable'), realtime.send('Profiler.enable')]);
    await Promise.all([renderer.send('Profiler.start'), realtime.send('Profiler.start')]);
  } catch (error) {
    realtime?.close();
    await renderer.detach();
    throw error;
  }
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    try {
      const profiles = await Promise.all([renderer.send('Profiler.stop'), realtime.send('Profiler.stop')]);
      for (const [index, name] of ['renderer', 'realtime'].entries()) {
        fs.writeFileSync(path.join(directory, `${label}-${name}.cpuprofile`), JSON.stringify(profiles[index].profile));
      }
    } finally {
      realtime.close();
      await renderer.detach();
    }
  };
}
