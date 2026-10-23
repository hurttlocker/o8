import fs from 'node:fs';
import { createServer } from 'node:http';
import { isReservedPort } from './common.mjs';

// This code is inserted only into the generated, disposable frontend loader.
// The native API hint is already injected by the shell. The harness reserves
// its adjacent measurement port before launch; no installed listener is used.
export function instrumentNativeLoader(file) {
  const html = fs.readFileSync(file, 'utf8');
  if (html.includes('o8-speed-native-paint-probe')) return;
  const probe = `<script id="o8-speed-native-paint-probe">
  (() => {
    const hint = window.__O8_PORT_HINT__;
    if (!Number.isInteger(hint)) return;
    const post = (stage, time) => {
      fetch('http://127.0.0.1:' + (hint + 2) + '/mark', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ stage, epochMs: performance.timeOrigin + time })
      }).catch(() => {});
    };
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') post('loader-first-contentful-paint', entry.startTime);
      }).observe({ type: 'paint', buffered: true });
    } catch {}
    requestAnimationFrame(() => requestAnimationFrame(() => post('loader-two-frame-ack', performance.now())));
  })();
  </script>`;
  if (!html.includes('</head>')) throw new Error('Generated native loader has no head');
  fs.writeFileSync(file, html.replace('</head>', probe + '</head>'));
}
export async function paintController(apiPort) {
  const port = apiPort + 2;
  if (port > 65535 || isReservedPort(port)) throw new Error('Measurement port is reserved or outside TCP range');
  const marks = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Connection', 'close');
    if (request.url !== '/mark' || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 2048) { response.writeHead(413); response.end(); return; } chunks.push(chunk); }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString());
      if (!['loader-first-contentful-paint', 'loader-two-frame-ack'].includes(value.stage) || !Number.isFinite(value.epochMs)) throw new Error('Invalid paint mark');
      marks.push({ ...value, receivedEpochMs: Date.now() });
      response.writeHead(204); response.end();
    } catch { response.writeHead(400); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port, marks, close: () => new Promise(resolve => server.close(resolve)) };
}
