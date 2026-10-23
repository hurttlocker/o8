import { execFileSync, spawnSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-lease-clock-'));
const driver = join(root, 'owner.cjs');
const delayedHost = join(root, 'terminal.cjs');
const native = join(process.cwd(), 'src-tauri/target/debug/examples/admission');
beforeAll(async () => {
  // The separate CLI smoke test builds with production configuration and no stubs.
  await build({ entryPoints: ['tests/fixtures/update-lease-owner-driver.ts'], outfile: driver, bundle: true, platform: 'node', format: 'cjs',
    alias: { '@': join(process.cwd(), 'src'), 'server-only': join(process.cwd(), 'tests/stubs/server-only.ts') } });
  await build({ entryPoints: ['tests/fixtures/update-delayed-terminal-host.ts'], outfile: delayedHost, bundle: true, platform: 'node', format: 'cjs',
    alias: { '@': join(process.cwd(), 'src') } });
  execFileSync('cargo', ['build', '--manifest-path', 'crates/o8-restart-safety/Cargo.toml', '--example', 'admission'], {
    env: { ...process.env, CARGO_BUILD_JOBS: '2', CARGO_TARGET_DIR: 'src-tauri/target' }, stdio: 'pipe' });
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function owner(name: string, bound = false) {
  const data = join(root, name);
  const child = spawn(process.execPath, [driver, bound ? 'bound' : 'unbound'], { env: { ...process.env, O8_DATA_DIR: data,
    CORTEX_IDE_DATA_DIR: data, TZ: 'UTC' }, stdio: 'pipe' });
  const lines = createInterface({ input: child.stdout });
  const ready = await once(lines, 'line'); expect(JSON.parse(String(ready[0]))).toMatchObject({ ready: true });
  const path = join(data, 'work-launches', readdirSync(join(data, 'work-launches'))[0]);
  const send = async (command: string) => { const response = once(lines, 'line'); child.stdin.write(`${command}\n`); return JSON.parse(String((await response)[0])); };
  const stop = async () => { const exited = once(child, 'exit'); child.stdin.end('stop\n'); await exited; lines.close(); };
  return { data, path, child: child as ChildProcessWithoutNullStreams, send, stop };
}

it.each(['Node', 'native'])('keeps a fresh unbound lease across a +60 second wall-clock jump (%s)', async entry => {
  const fixture = await owner(`jump-${entry}`);
  try {
    if (entry === 'Node') expect((await fixture.send('jump')).leases).toHaveLength(1);
    else {
      const work = JSON.parse(readFileSync(fixture.path, 'utf8'));
      work.createdAtMs -= 60_000; // Equivalent wall-clock skew at the native reader.
      writeFileSync(fixture.path, JSON.stringify(work));
      expect(() => execFileSync(native, [fixture.data], { stdio: 'pipe', env: { ...process.env, TZ: 'UTC' } })).toThrow();
      expect(existsSync(join(fixture.data, 'native-cleanup'))).toBe(false);
    }
  } finally { await fixture.stop(); }
});

it('rejects binding after native reclamation without recreating its reader', async () => {
  const fixture = await owner('late');
  try {
    const work = JSON.parse(readFileSync(fixture.path, 'utf8'));
    work.createdAtMs -= 31_000;
    work.createdMonotonicMs = Number(process.hrtime.bigint()) / 1e6 - 31_000;
    writeFileSync(fixture.path, JSON.stringify(work));
    execFileSync(native, [fixture.data], { stdio: 'pipe', env: { ...process.env, TZ: 'UTC' } });
    expect(existsSync(fixture.path)).toBe(false);
    expect(await fixture.send('bind')).toHaveProperty('error');
    expect(existsSync(fixture.path)).toBe(false);
  } finally { await fixture.stop(); }
});

it.each(['Node', 'native'])('preserves a live bound UTC owner inspected from America/New_York (%s)', async entry => {
  const fixture = await owner(`timezone-${entry}`, true);
  try {
    const env = { ...process.env, O8_DATA_DIR: fixture.data, CORTEX_IDE_DATA_DIR: fixture.data, TZ: 'America/New_York' };
    if (entry === 'native') expect(() => execFileSync(native, [fixture.data], { stdio: 'pipe', env })).toThrow();
    else {
      const result = spawnSync(process.execPath, [driver, 'inspect'], { env, encoding: 'utf8', timeout: 5_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).leases).toHaveLength(1);
    }
    expect(existsSync(fixture.path)).toBe(true);
    expect(existsSync(join(fixture.data, 'native-cleanup'))).toBe(false);
  } finally { await fixture.stop(); }
});

it('bounds legacy records using elapsed monotonic time rather than their wall-clock age', async () => {
  const fixture = await owner('legacy');
  try {
    const work = JSON.parse(readFileSync(fixture.path, 'utf8'));
    delete work.createdMonotonicMs; work.createdAtMs = 1;
    writeFileSync(fixture.path, JSON.stringify(work));
    expect((await fixture.send('jump')).leases).toHaveLength(1);
    expect((await fixture.send('advance')).leases).toEqual([]);
    // Node drops expired readers from inventory; native owns physical reclamation.
    expect(existsSync(fixture.path)).toBe(true);
    expect(await fixture.send('bind')).toHaveProperty('error');
  } finally { await fixture.stop(); }
});


it('refuses a delayed terminal IPC launch after native reclamation before creating the process', async () => {
  const data = join(root, 'delayed-terminal');
  const gate = join(data, 'deliver-ipc');
  const marker = join(data, 'launched');
  vi.stubEnv('O8_DATA_DIR', data);
  vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
  vi.stubEnv('O8_LEASE_TEST_GATE', gate);
  const { createChildTerminalHost } = await import('@/lib/ws-server/terminal-host-client');
  const host = createChildTerminalHost({ forkEntry: delayedHost, execArgv: [] });
  try {
    const terminal = host.spawn({ file: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
      cwd: data, env: {}, cols: 80, rows: 24 });
    const exit = new Promise<{ exitCode: number }>(resolve => terminal.onExit(resolve));
    const path = join(data, 'work-launches', readdirSync(join(data, 'work-launches'))[0]);
    const work = JSON.parse(readFileSync(path, 'utf8'));
    work.createdMonotonicMs = Number(process.hrtime.bigint()) / 1e6 - 31_000;
    writeFileSync(path, JSON.stringify(work));
    execFileSync(native, [data], { stdio: 'pipe' });
    expect(existsSync(path)).toBe(false);
    writeFileSync(gate, 'deliver');
    expect(await exit).toMatchObject({ exitCode: 1 });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path)).toBe(false);
  } finally { host.dispose(); vi.unstubAllEnvs(); }
});
