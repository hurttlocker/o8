import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { webkit } from 'playwright-core';
import { previewServer } from './server.mjs';
import { webBench } from './web-bench.mjs';
import { percentile } from './stats.mjs';

await mkdir('results/isolated', { recursive: true });
const only = process.argv.find(arg => arg.startsWith('--only='))?.split('=')[1];
const runs = process.argv.includes('--probe') ? 1 : 3;
const results = [];
const clock = () => Number(process.hrtime.bigint()) / 1e6;
const directory = process.argv.includes('--probe') ? 'raw/metric-probes' : 'results/isolated';
await mkdir(directory, { recursive: true });
async function child(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const started = clock();
    let coldLaunchMs;
    let buffer = '';
    const process = spawn(command, args, { env: { ...globalThis.process.env, NODE_ENV: 'production', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => process.kill(command.endsWith('o8-pure-gpui-transcript-bench') || args[0] === 'dist/native.mjs' ? 'SIGKILL' : 'SIGTERM'), command.endsWith('o8-pure-gpui-transcript-bench') || args[0] === 'dist/native.mjs' ? 9000 : 120000);
    let log = ''; process.stdout.on('data', data => {
      log += data; buffer += data;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { if (JSON.parse(line).kind === 'first-frame' && coldLaunchMs === undefined) coldLaunchMs = clock() - started; } catch {}
      }
    }); process.stderr.on('data', data => { log += data; });
    process.on('error', error => { clearTimeout(timer); reject(error); });
    process.on('exit', code => {
      clearTimeout(timer);
      if (code === 0 && coldLaunchMs !== undefined) resolve({ coldLaunchMs, processWallMs: clock() - started });
      else reject(Error(`${command} exited ${code}: ${log.slice(-3000)}`));
    });
  });
}
for (let run = 1; run <= runs; run++) {
  const surfaces = ['pure', 'native', 'web', 'terminal'];
  const order = surfaces.slice(run - 1).concat(surfaces.slice(0, run - 1));
  for (const surface of order.filter(value => !only || value === only)) {
    console.log(JSON.stringify({ event: 'start', surface, run }));
    const path = `${directory}/${surface}-${run}.json`;
    let row;
    if (surface === 'pure') {
      const timing = await child('./pure-gpui/target/x86_64-apple-darwin/release/o8-pure-gpui-transcript-bench', [], { BENCH_RESULT: path, BENCH_FIXTURE: 'dist/fixture.json' });
      row = { ...JSON.parse(await readFile(path, 'utf8')), ...timing };
    } else if (surface === 'native') {
      const timing = await child(process.execPath, ['dist/native.mjs'], { BENCH_RESULT: path });
      row = { ...JSON.parse(await readFile(path, 'utf8')), ...timing };
    } else if (surface === 'terminal') {
      const timing = await child('python3', ['terminal-bench.py', path], { BENCH_NODE: process.execPath });
      row = { ...JSON.parse(await readFile(path, 'utf8')), ...timing };
    } else {
      const server = await previewServer();
      const beforePids = execFileSync('ps', ['-axo', 'pid='], { encoding: 'utf8' }).trim().split(/\s+/).join(',');
      const launchStarted = clock();
      const owner = await webkit.launchServer({ headless: true });
      const browser = await webkit.connect(owner.wsEndpoint());
      try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 816 }, deviceScaleFactor: 1 });
        page.on('pageerror', error => console.error('Page error:', String(error)));
        await page.goto(server.url);
        await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
        const coldLaunchMs = clock() - launchStarted;
        const memory = JSON.parse(execFileSync('dist/memory', [String(owner.process().pid)], { encoding: 'utf8', env: { ...process.env, BENCH_BEFORE_PIDS: beforePids } }));
        if (memory.processes.filter(p => p.role === 'web-content').length !== 1) throw Error(`Expected exactly one attributed WebKit content process: ${JSON.stringify(memory)}`);
        row = { ...await page.evaluate(webBench), coldLaunchMs, idleRssMiB: memory.rssMiB, memoryComponents: memory };
        row.browserVersion = browser.version();
        await writeFile(path, JSON.stringify(row, null, 2));
      } finally { await browser.close(); await owner.close(); await server.close(); }
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
    await writeFile(`${directory}/${surface}-${run}-summary.json`, JSON.stringify(summary, null, 2));
  }
}
