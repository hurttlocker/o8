import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

describe('shared API reads during reopen', () => {
  it('handles an actual aborted HTTP read without an orphan rejection and retries successfully', async () => {
    // A separate process retains Node's strict unhandled-rejection behavior.
    // The HTTP transport, cache and SWR call path are all the real modules.
    const script = `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      import { once } from 'node:events';
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const { fetchOnce, fetchSWRJson } = require('./src/lib/panel/fetch-cache.ts');
      const server = createServer();
      let requests = 0;
      let onRequested;
      const requested = new Promise(resolve => { onRequested = resolve; });
      server.on('request', (_request, response) => {
        requests += 1;
        if (requests === 1) { onRequested(); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ repos: ['restored'] }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const url = 'http://127.0.0.1:' + server.address().port + '/api/panel/repos';
        const controller = new AbortController();
        const reads = Promise.allSettled([
          fetchSWRJson('reopen:repos', url, { signal: controller.signal }),
          fetchOnce(url),
        ]);
        await requested;
        controller.abort();
        const results = await reads;
        assert.equal(results.length, 2);
        for (const result of results) {
          assert.equal(result.status, 'rejected');
          assert.equal(result.reason.name, 'AbortError');
        }
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(await fetchSWRJson('reopen:repos', url), { repos: ['restored'] });
        assert.equal(requests, 2);
        console.log(JSON.stringify({ abortedCallers: results.length, requests, recovered: true }));
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const { stdout, stderr } = await exec(process.execPath, [
      '--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '-e', script,
    ], { cwd: root, timeout: 15_000, env: { ...process.env, NODE_OPTIONS: '' } });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout.trim())).toEqual({ abortedCallers: 2, requests: 2, recovered: true });
  });
});
