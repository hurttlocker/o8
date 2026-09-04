// The fixture page runs in its own tagged process. This makes its lifecycle
// visible to the same process-tree cleanup proof as the packaged servers and
// browser helpers; an in-process HTTP server could only be inferred from a port.
import { fork } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { designFixturePage } from './fixtures.mjs';

const CHILD_FLAG = '--serve-interaction-fixture';

function createServer(seed) {
  const page = designFixturePage(seed);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(page.html);
  });
  return { page, server };
}

async function serveChild(seed) {
  const { page, server } = createServer(seed);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  process.send?.({
    port: typeof address === 'object' && address ? address.port : 0,
    digest: page.digest,
    targetBlockId: page.targetBlockId,
    blockCount: page.blocks.length,
  });
  const close = () => server.close(() => process.exit(0));
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

export async function startFixturePageServer(seed, { runTag } = {}) {
  if (!runTag) throw new Error('fixture server requires an interaction run tag');
  const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG, String(seed), runTag], {
    detached: true,
    env: { ...process.env, O8_INTERACTION_RUN_TAG: runTag },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture server did not report a port within 10s')), 10_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`fixture server exited ${code} before ready`)); });
    child.once('message', (message) => { clearTimeout(timer); resolve(message); });
  });
  return {
    ...ready,
    pid: child.pid,
    url: `http://127.0.0.1:${ready.port}/`,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

if (process.argv[2] === CHILD_FLAG) {
  await serveChild(Number(process.argv[3]));
}
