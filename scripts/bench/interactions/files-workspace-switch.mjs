#!/usr/bin/env node
// Production Files explorer; directory responses are deterministic fixtures.
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright-core';
import { resolveBrowserPath } from '../measure-browser-boot.mjs';
import { launchMeasuredBrowser, closeMeasuredBrowser } from './browser-runtime.mjs';

const option = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const engine = option('engine', 'chromium');
const output = path.resolve(option('output', 'tests/bench/latest/files-workspace-switch.json'));
const expectRetained = process.argv.includes('--expect-retained');
if (!['chromium', 'webkit'].includes(engine)) throw new Error('Use --engine=chromium|webkit.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(path.join(tmpdir(), 'o8-files-switch-'));
const bundle = path.join(directory, 'fixture.js');
let server; let browser; let measured;
const errors = [];
const observations = [];
try {
  await build({ absWorkingDir: root, bundle: true, format: 'esm', platform: 'browser', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }, outfile: bundle,
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { AllFilesTree } from './src/components/desktop/o8-panel/workspace-rail/AllFilesTree';
      const dirtyFiles = new Set();
      function Fixture() {
        const [repo, setRepo] = useState('a');
        return <main style={{width: 600, height: 500, display: 'flex', flexDirection: 'column'}}>
          <nav>{['a', 'b', 'c', 'd'].map(id => <button key={id} onClick={() => setRepo(id)}>Workspace {id}</button>)}</nav>
          <AllFilesTree repoPath={'/fixture/' + repo} selectedFile={null} dirtyFiles={dirtyFiles} onSelectFile={() => {}} />
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    ` } });
  const js = await readFile(bundle);
  let inFlight = 0;
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); return; }
    if (url.pathname === '/api/panel/files') {
      const repo = url.searchParams.get('workspace')?.split('/').at(-1);
      const folder = url.searchParams.get('directory');
      const entries = folder === '.'
        ? [{ name: 'src', path: 'src', kind: 'directory' }, ...Array.from({ length: 400 }, (_, index) => ({ name: `file-${index}.ts`, path: `file-${index}.ts`, kind: 'file' }))]
        : [{ name: `marker-${repo}.ts`, path: `src/marker-${repo}.ts`, kind: 'file' }];
      inFlight++;
      setTimeout(() => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ entries })); inFlight--; }, 200);
      return;
    }
    if (url.pathname.startsWith('/api/')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ groups: [] })); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  if (engine === 'chromium') { measured = await launchMeasuredBrowser(resolveBrowserPath(), `o8-files-switch-${process.pid}`); browser = measured.browser; }
  else browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const tree = () => page.locator('file-tree-container').first();
  const item = name => tree().locator(`[data-item-path="${name}"]`);
  const settle = async () => { while (inFlight) await new Promise(resolve => setTimeout(resolve, 10)); };
  for (let sample = 0; sample < 3; sample++) {
    await page.getByRole('button', { name: 'Workspace a', exact: true }).click();
    await item('src/').waitFor({ state: 'visible' });
    if (await item('src/').getAttribute('aria-expanded') !== 'true') await item('src/').click();
    await item('src/marker-a.ts').waitFor({ state: 'visible' });
    await settle();
    await page.getByRole('button', { name: 'Workspace b', exact: true }).click();
    await item('src/').waitFor({ state: 'visible' }); await settle();
    const before = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: 'Workspace a', exact: true }).click();
    await item('src/').waitFor({ state: 'visible' });
    const reopened = await item('src/').getAttribute('aria-expanded') !== 'true';
    if (reopened) await item('src/').click();
    await item('src/marker-a.ts').waitFor({ state: 'visible' });
    const elapsedMs = await page.evaluate(() => performance.now()) - before;
    observations.push({ sample, elapsedMs, reopened });
    await settle();
  }
  const passed = !errors.length && (!expectRetained || observations.every(value => !value.reopened));
  const receipt = { engine, expectRetained, passed, observations, errors,
    medianMs: observations.map(value => value.elapsedMs).sort((a, b) => a - b)[1],
    workload: { entries: 401, directoryDelayMs: 200, samples: 3 },
    limits: 'Isolated production Files component. Synthetic directory latency, no provider calls. This measures return-to-expanded-index latency, not CPU savings, full dashboard streaming or native acceptance.' };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log('[files-workspace-switch]', JSON.stringify(receipt));
  if (!passed) process.exitCode = 1;
} finally {
  if (measured) await closeMeasuredBrowser(measured); else await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
