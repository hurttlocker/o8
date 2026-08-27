// o8 benchmark-suite entrypoint; see tests/bench/README.md for usage.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const METRICS = [
  'time_to_splash_ms',
  'time_to_reveal_ms',
  'boot_api_request_count',
  'max_client_queue_stall_ms',
  'panel_branches_ms',
  'runtime_inventory_ms',
  'dashboard_cold_ttfb_ms',
  'dashboard_warm_ttfb_ms',
  'bootstrap_warm_total_ms',
  'cli_status_median_ms',
  'mcp_client_minus_server_p50_ms',
  'socket_avg_conns',
];

const LATEST_DIR = path.resolve(process.env.O8_BENCH_LATEST_DIR || path.join(process.cwd(), 'tests/bench/latest'));
const OUT_PATH = path.join(LATEST_DIR, 'speed.json');

function nullMetric(note) {
  return { value: null, note };
}

function emptyMetrics(note) {
  return Object.fromEntries(METRICS.map((name) => [name, nullMetric(note)]));
}

function readPort() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.o8/api-port'), 'utf8').trim();
    return raw || '3001';
  } catch {
    return '3001';
  }
}

function serverIsRunning(port) {
  const result = spawnSync('curl', ['-fsS', '--max-time', '2', `http://127.0.0.1:${port}/`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return !result.error && result.status === 0;
}

function writeSpeed(metrics) {
  fs.mkdirSync(LATEST_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    metrics,
  }, null, 2));
}

function stderrFirstLine(result) {
  if (result.error) return result.error.message;
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';
  return stderr.split('\n').find((line) => line.trim())?.trim() || 'no stderr';
}

function runHarness(scriptName, args = []) {
  const absolutePath = path.resolve(process.cwd(), 'scripts', scriptName);
  const result = spawnSync('bash', [absolutePath, ...args], { stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    const status = result.status ?? 'error';
    return {
      ok: false,
      stdout: result.stdout ? result.stdout.toString('utf8') : '',
      note: `harness exit ${status}: ${stderrFirstLine(result)}`,
    };
  }
  return {
    ok: true,
    stdout: result.stdout ? result.stdout.toString('utf8') : '',
    note: '',
  };
}

function runNodeHarness(scriptName) {
  const absolutePath = path.resolve(process.cwd(), 'scripts', 'bench', scriptName);
  const result = spawnSync(process.execPath, [absolutePath], {
    encoding: 'utf8',
    env: process.env,
    timeout: 65_000,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout || '',
      note: `harness exit ${result.status ?? 'error'}: ${stderrFirstLine(result)}`,
    };
  }
  return { ok: true, stdout: result.stdout || '', note: '' };
}

function parseMsFromSeconds(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value * 1000) : null;
}

function parseInteger(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.round(value) : null;
}

function parseFloatValue(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function assignParsed(metrics, name, value, note = 'metric not found') {
  metrics[name] = typeof value === 'number' ? value : nullMetric(note);
}

function parseRender(stdout, metrics) {
  let coldDashboard = null;
  let warmDashboard = null;
  let warmBootstrap = null;
  for (const line of stdout.split('\n')) {
    const col = line.split('\t');
    if (col[0] === 'cold' && col[1] === '/dashboard') {
      coldDashboard = parseMsFromSeconds(col[2]);
    } else if (col[0] === 'warm' && col[1] === '/dashboard') {
      warmDashboard = parseMsFromSeconds(col[2]);
    } else if (col[0] === 'warm' && col[1] === '/api/mobile/bootstrap') {
      warmBootstrap = parseMsFromSeconds(col[3]);
    }
  }
  assignParsed(metrics, 'dashboard_cold_ttfb_ms', coldDashboard);
  assignParsed(metrics, 'dashboard_warm_ttfb_ms', warmDashboard);
  assignParsed(metrics, 'bootstrap_warm_total_ms', warmBootstrap);
}

function parseCli(stdout, metrics) {
  let statusMedian = null;
  for (const line of stdout.split('\n')) {
    const col = line.split('\t');
    if (col[0] === 'status') {
      statusMedian = parseInteger(col[3]);
    }
  }
  assignParsed(metrics, 'cli_status_median_ms', statusMedian);
}

function parseMcp(stdout, metrics) {
  let overhead = null;
  for (const line of stdout.split('\n')) {
    const col = line.split('\t');
    if (col[0] === 'client_minus_server') {
      overhead = parseInteger(col[1]);
    }
  }
  assignParsed(metrics, 'mcp_client_minus_server_p50_ms', overhead);
}

function parseSocket(stdout, metrics) {
  let avg = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('avg\t')) {
      avg = parseFloatValue(line.split('\t')[1]);
    }
  }
  assignParsed(metrics, 'socket_avg_conns', avg);
}

function parseBrowserBoot(stdout, metrics) {
  const receiptLine = stdout.split('\n').find((line) => line.startsWith('O8_BROWSER_BOOT_RECEIPT='));
  if (!receiptLine) {
    markHarnessFailure(metrics, METRICS.slice(0, 6), 'browser boot receipt missing');
    return;
  }
  try {
    const receipt = JSON.parse(receiptLine.slice('O8_BROWSER_BOOT_RECEIPT='.length));
    for (const name of METRICS.slice(0, 6)) {
      const value = receipt.metrics?.[name];
      metrics[name] = typeof value === 'number' || (value && typeof value.note === 'string')
        ? value
        : nullMetric('browser boot metric missing');
    }
  } catch (error) {
    markHarnessFailure(
      metrics,
      METRICS.slice(0, 6),
      `browser boot receipt invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function markHarnessFailure(metrics, names, note) {
  for (const name of names) metrics[name] = nullMetric(note);
}

function printSummary(metrics) {
  console.log('metric\tvalue\tnote');
  for (const name of METRICS) {
    const value = metrics[name];
    if (typeof value === 'number') {
      console.log(`${name}\t${value}\t`);
    } else {
      console.log(`${name}\tnull\t${value.note}`);
    }
  }
}

function main() {
  const port = readPort();
  if (!serverIsRunning(port)) {
    const metrics = emptyMetrics('server not running');
    writeSpeed(metrics);
    printSummary(metrics);
    return;
  }

  const metrics = emptyMetrics('metric not run');

  const render = runHarness('measure-render-speed.sh');
  if (render.ok) {
    parseRender(render.stdout, metrics);
  } else {
    markHarnessFailure(metrics, [
      'dashboard_cold_ttfb_ms',
      'dashboard_warm_ttfb_ms',
      'bootstrap_warm_total_ms',
    ], render.note);
  }

  const browserBoot = runNodeHarness('measure-browser-boot.mjs');
  if (browserBoot.ok) {
    parseBrowserBoot(browserBoot.stdout, metrics);
  } else {
    markHarnessFailure(metrics, METRICS.slice(0, 6), browserBoot.note);
  }

  const cli = runHarness('measure-cli.sh');
  if (cli.ok) {
    parseCli(cli.stdout, metrics);
  } else {
    markHarnessFailure(metrics, ['cli_status_median_ms'], cli.note);
  }

  const mcp = runHarness('measure-mcp.sh');
  if (mcp.ok) {
    parseMcp(mcp.stdout, metrics);
  } else {
    markHarnessFailure(metrics, ['mcp_client_minus_server_p50_ms'], mcp.note);
  }

  const socket = runHarness(
    'measure-socket.sh',
    process.env.O8_BENCH_SOCKET_DURATION_SECONDS
      ? [process.env.O8_BENCH_SOCKET_DURATION_SECONDS]
      : [],
  );
  if (socket.ok) {
    parseSocket(socket.stdout, metrics);
  } else {
    markHarnessFailure(metrics, ['socket_avg_conns'], socket.note);
  }

  writeSpeed(metrics);
  printSummary(metrics);
}

try {
  main();
} catch (err) {
  const note = err instanceof Error ? err.message : String(err);
  try {
    const metrics = emptyMetrics(`run-speed failed: ${note}`);
    writeSpeed(metrics);
    printSummary(metrics);
  } catch {
    console.error(`run-speed failed: ${note}`);
  }
  process.exitCode = 0;
}
