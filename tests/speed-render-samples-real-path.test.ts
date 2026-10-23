import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'o8-speed-render-samples-'));
const runner = path.resolve('scripts/bench/run-speed.mjs');
const bin = path.join(root, 'bin');
const home = path.join(root, 'fixture-home');
mkdirSync(bin);
mkdirSync(path.join(home, '.o8'), { recursive: true });
writeFileSync(path.join(home, '.o8', 'api-port'), '49123');
const preload = path.join(root, 'isolate-home.cjs');
writeFileSync(preload, "require('node:os').homedir = () => process.env.O8_SPEED_FIXTURE_HOME;\n");
// Only the liveness probe uses curl. This fixture never contacts a live server.
writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env node\nprocess.exit(0);\n');
chmodSync(path.join(bin, 'curl'), 0o755);
let sequence = 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

function row(phase: string, route: string, ttfb: string, total: string, status: string): string {
  return [phase, route, ttfb, total, status, '0', `http://127.0.0.1:49123${route}`].join('\t');
}

function run(rows: string[]) {
  const fixture = path.join(root, `run-${++sequence}`);
  const scripts = path.join(fixture, 'scripts');
  const latest = path.join(fixture, 'latest');
  mkdirSync(path.join(scripts, 'bench'), { recursive: true });
  const output = path.join(fixture, 'render.tsv');
  writeFileSync(output, rows.join('\n') + '\n');
  writeFileSync(path.join(scripts, 'measure-render-speed.sh'), 'cat "$O8_SPEED_FIXTURE_ROWS"\n');
  for (const [file, text] of [
    ['measure-cli.sh', 'status\t8\t12\t10\n'],
    ['measure-mcp.sh', 'client_minus_server\t3\t4\n'],
    ['measure-socket.sh', 'avg\t2.5\n'],
  ] as const) writeFileSync(path.join(scripts, file), `printf '%s' '${text}'\n`);
  writeFileSync(path.join(scripts, 'bench', 'measure-browser-boot.mjs'), `
console.log('O8_BROWSER_BOOT_RECEIPT=' + JSON.stringify({
  target: { appVersion: '0.0.0-fixture', buildGitSha: null, buildMode: 'fixture', platform: 'fixture' },
  metrics: { time_to_splash_ms: 30, time_to_reveal_ms: 40, boot_api_request_count: 4,
    max_client_queue_stall_ms: 5, panel_branches_ms: 6, runtime_inventory_ms: 7 }
}));
`);
  execFileSync(process.execPath, [runner], {
    cwd: fixture, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${preload}`.trim(),
      O8_SPEED_FIXTURE_HOME: home, O8_SPEED_FIXTURE_ROWS: output, O8_BENCH_LATEST_DIR: latest },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const receipt = JSON.parse(readFileSync(path.join(latest, 'speed.json'), 'utf8'));
  expect(receipt.metrics.cli_status_median_ms).toBe(10);
  expect(receipt.metrics.mcp_client_minus_server_p50_ms).toBe(3);
  expect(receipt.metrics.socket_avg_conns).toBe(2.5);
  expect(receipt.metrics.time_to_reveal_ms).toBe(40);
  return receipt.metrics;
}

it.each(['401', '503'])('records HTTP %s render samples as unavailable instead of fast', status => {
  const metrics = run([
    row('cold', '/dashboard', '0.001', '0.002', status),
    row('warm', '/dashboard', '0.001', '0.002', status),
    row('warm', '/api/mobile/bootstrap', '0.001', '0.002', status),
  ]);
  for (const name of ['dashboard_cold_ttfb_ms', 'dashboard_warm_ttfb_ms', 'bootstrap_warm_total_ms']) {
    expect(metrics[name]).toEqual({ value: null, note: expect.stringContaining(`HTTP ${status}`) });
  }
});

it.each(['', '   ', '-0.01', 'Infinity', '1e308'])(
  'records invalid render duration %j as unavailable', duration => {
    const metrics = run([
      row('cold', '/dashboard', duration, '0.002', '200'),
      row('warm', '/dashboard', duration, '0.002', '200'),
      row('warm', '/api/mobile/bootstrap', '0.001', duration, '200'),
    ]);
    for (const name of ['dashboard_cold_ttfb_ms', 'dashboard_warm_ttfb_ms', 'bootstrap_warm_total_ms']) {
      expect(metrics[name]).toEqual({ value: null, note: expect.any(String) });
    }
  },
);

it('keeps valid successful samples and preserves valid metrics beside a failed sample', () => {
  const metrics = run([
    row('cold', '/dashboard', '0.1255', '0.200', '200'),
    row('warm', '/dashboard', '0', '0.002', '204'),
    row('warm', '/api/mobile/bootstrap', '0.001', '0.0067', '200'),
  ]);
  expect(metrics.dashboard_cold_ttfb_ms).toBe(126);
  expect(metrics.dashboard_warm_ttfb_ms).toBe(0);
  expect(metrics.bootstrap_warm_total_ms).toBe(7);
  const mixed = run([
    row('cold', '/dashboard', '0.001', '0.002', ''),
    row('warm', '/dashboard', '0.015', '0.020', '200'),
  ]);
  expect(mixed.dashboard_cold_ttfb_ms).toEqual({ value: null, note: expect.any(String) });
  expect(mixed.dashboard_warm_ttfb_ms).toBe(15);
  expect(mixed.bootstrap_warm_total_ms).toEqual({ value: null, note: expect.any(String) });
});
