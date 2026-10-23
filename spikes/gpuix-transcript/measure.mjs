import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { webkit } from 'playwright-core';
import { previewServer } from './server.mjs';
import { webBench } from './web-bench.mjs';
import { percentile } from './stats.mjs';

await mkdir('results/isolated', { recursive: true });
const only = process.argv.find(arg => arg.startsWith('--only='))?.split('=')[1];
const runs = process.argv.includes('--probe') ? 1 : 3;
const results = [];
async function child(command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const process = spawn(command, args, { env: { ...globalThis.process.env, NODE_ENV: 'production', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => process.kill(args[0] === 'dist/native.mjs' ? 'SIGKILL' : 'SIGTERM'), args[0] === 'dist/native.mjs' ? 9000 : 120000);
    let log = ''; process.stdout.on('data', data => { log += data; }); process.stderr.on('data', data => { log += data; });
    process.on('error', error => { clearTimeout(timer); reject(error); });
    process.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Error(`${command} exited ${code}: ${log.slice(-3000)}`));
    });
  });
}
for (let run = 1; run <= runs; run++) {
  const surfaces = ['native', 'web', 'terminal'];
  const order = surfaces.slice(run - 1).concat(surfaces.slice(0, run - 1));
  for (const surface of order.filter(value => !only || value === only)) {
    console.log(JSON.stringify({ event: 'start', surface, run }));
    const path = `results/isolated/${surface}-${run}.json`;
    let row;
    if (surface === 'native') {
      await child(process.execPath, ['dist/native.mjs'], { BENCH_RESULT: path });
      row = JSON.parse(await readFile(path, 'utf8'));
    } else if (surface === 'terminal') {
      await child('python3', ['terminal-bench.py', path], { BENCH_NODE: process.execPath });
      row = JSON.parse(await readFile(path, 'utf8'));
    } else {
      const server = await previewServer();
      const browser = await webkit.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 816 }, deviceScaleFactor: 1 });
        page.on('pageerror', error => console.error('Page error:', String(error)));
        await page.goto(server.url);
        await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
        row = await page.evaluate(webBench);
        row.browserVersion = browser.version();
        await writeFile(path, JSON.stringify(row, null, 2));
      } finally { await browser.close(); await server.close(); }
    }
    row.run = run;
    await writeFile(path, JSON.stringify(row, null, 2));
    results.push(row);
    const quantiles = list => Object.fromEntries([['p50', .5], ['p95', .95], ['p99', .99]].map(([key, q]) => [key, percentile(list, q)]));
    const summary = { surface, run, keysMs: quantiles(row.keys.map(value => value.elapsedMs)),
      streamMs: quantiles(row.stream.map(value => value.costMs ?? value.elapsedMs)),
      scrollMs: quantiles(row.scroll.map(value => value.costMs ?? value.elapsedMs)),
      tokensPerSecond: row.tokensPerSecond, fixtureHash: row.fixtureHash };
    console.log(JSON.stringify({ event: 'complete', ...summary }));
    await writeFile(`results/isolated/${surface}-${run}-summary.json`, JSON.stringify(summary, null, 2));
  }
}
