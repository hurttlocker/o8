import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import nextConfig from '../next.config';
import { assertMacPackageSize } from '../scripts/lib/mac-package-size.mjs';
import { assertTauriExportInputsSafe } from '../scripts/lib/tauri-export-safety.mjs';
import { FOOTPRINT_BUDGET } from '../scripts/lib/footprint-budget.mjs';

const roots: string[] = [];
const sourceRoot = process.cwd();
const picomatch = createRequire(import.meta.url)('next/dist/compiled/picomatch') as (
  patterns: string[], options: { dot: boolean; contains: boolean },
) => (path: string) => boolean;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-package-preflight-'));
  roots.push(root);
  const app = join(root, 'src-tauri/target/release/bundle/macos/o8.app');
  const server = join(app, 'Contents/Resources/server');
  for (const file of ['server.js', '.next/server/app/page.js', '.next/static/chunks/main.js',
    '.next/required-server-files.json', 'node_modules/better-sqlite3/binding.node']) {
    mkdirSync(dirname(join(server, file)), { recursive: true });
    writeFileSync(join(server, file), `runtime:${file}`);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.742' }));
  return { root, app, server };
}

function putCache(server: string, kind: 'cache' | 'dev' = 'cache') {
  const file = join(server, kind === 'dev'
    ? '.next/dev/cache/turbopack/v16.3.4/00000098.sst'
    : '.next/cache/webpack/server-production/3.pack');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'compiler-only');
  return file;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('packaging preflight through real filesystem and script entry points', () => {
  it('keeps development startup from rewriting repository-authored agent instructions', () => {
    expect(nextConfig.agentRules).toBe(false);
  });

  it('uses the tracing matcher to exclude build cache without excluding runtime assets', () => {
    const patterns = nextConfig.outputFileTracingExcludes!['*'].map(pattern => join(sourceRoot, pattern));
    const excluded = picomatch(patterns, { dot: true, contains: true });
    for (const file of ['.next/cache/.tsbuildinfo', '.next/cache/webpack/server-production/3.pack',
      '.next/cache/webpack/client-production/index.pack.old',
      '.next/dev/cache/turbopack/v16.3.4/00000098.sst', '.next/dev/server/app/page.js']) {
      expect(excluded(join(sourceRoot, file)), file).toBe(true);
    }
    for (const file of ['.next/server/app/page.js', '.next/static/chunks/main.js',
      '.next/prerender-manifest.json', '.next/required-server-files.json',
      'node_modules/better-sqlite3/binding.node']) {
      expect(excluded(join(sourceRoot, file)), file).toBe(false);
    }
  });

  it.each(['cache', 'dev'] as const)('rejects a %s directory and a dangling link without changing input', (kind) => {
    const f = fixture();
    const cacheFile = putCache(f.server, kind);
    expect(() => assertTauriExportInputsSafe(f.server)).toThrow(`contains .next/${kind}`);
    expect(readFileSync(cacheFile, 'utf8')).toBe('compiler-only');
    const linked = fixture();
    symlinkSync(join(linked.root, 'missing-cache'), join(linked.server, '.next', kind), 'dir');
    expect(() => assertTauriExportInputsSafe(linked.server)).toThrow(`contains .next/${kind}`);
  });

  it.each(['cache', 'dev'] as const)('rejects traced %s before the actual exporter clears previous staging', (kind) => {
    const f = fixture();
    const standalone = join(f.root, '.next/standalone');
    const cacheFile = putCache(standalone, kind);
    const sentinel = join(f.root, 'out/keep.txt');
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, 'previous-output');
    for (const file of ['tauri-export.mjs', 'native-bundle.mjs', 'tauri-hook-resources.mjs',
      'run-lib.mjs', 'lib/release-config.mjs', 'lib/tauri-export-safety.mjs']) {
      const destination = join(f.root, 'scripts', file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(sourceRoot, 'scripts', file), destination);
    }
    const result = spawnSync(process.execPath, [join(f.root, 'scripts/tauri-export.mjs')], {
      cwd: f.root, encoding: 'utf8', timeout: 10_000,
      env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: f.root },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(`contains .next/${kind}`);
    expect(readFileSync(sentinel, 'utf8')).toBe('previous-output');
    expect(readFileSync(cacheFile, 'utf8')).toBe('compiler-only');
  });

  it('measures a fresh archive and preserves runtime files and an older updater', () => {
    const f = fixture();
    writeFileSync(`${f.app}.tar.gz`, 'older-updater');
    const result = assertMacPackageSize(f.app);
    expect(result.appBundleBytes).toBeGreaterThan(0);
    expect(result.updaterArchiveBytes).toBeGreaterThan('older-updater'.length);
    expect(result.updaterArchiveBytes).toBeLessThan(FOOTPRINT_BUDGET.regressionCeilings.updaterArchiveBytes);
    expect(readFileSync(`${f.app}.tar.gz`, 'utf8')).toBe('older-updater');
    expect(readFileSync(join(f.server, '.next/static/chunks/main.js'), 'utf8')).toBe('runtime:.next/static/chunks/main.js');
    expect(existsSync(join(f.server, 'node_modules/better-sqlite3/binding.node'))).toBe(true);
    expect(() => assertMacPackageSize(f.app, join(f.root, 'missing.tar.gz'))).toThrow();
  });

  it('rejects an oversized final archive without deleting the evidence', () => {
    const f = fixture();
    const archive = `${f.app}.tar.gz`;
    writeFileSync(archive, 'final-archive');
    truncateSync(archive, FOOTPRINT_BUDGET.regressionCeilings.updaterArchiveBytes + 1);
    expect(() => assertMacPackageSize(f.app, archive)).toThrow('updaterArchiveBytes');
    expect(existsSync(archive)).toBe(true);
  });

  it.each(['bundle', 'archive', 'cache', 'dev', 'safe'] as const)(
    'guards the actual signing entry point for %s input before platform operations', (scenario) => {
      const f = fixture();
      if (scenario === 'cache' || scenario === 'dev') putCache(f.server, scenario);
      const log = join(f.root, 'calls.jsonl');
      // Simulate only process/platform edges. The actual signing entry point,
      // size policy, cache guard, stat reads and temp cleanup execute unchanged.
      const childProcess = `import { appendFileSync, readFileSync, writeFileSync, truncateSync } from 'node:fs';
export function execFileSync(command, args) {
  appendFileSync(process.env.O8_SIZE_TEST_LOG, JSON.stringify({command, args}) + '\\n');
  if (command === 'cat') return readFileSync(args[0], 'utf8');
  if (command === 'du') return process.env.O8_SIZE_TEST_KIB + '\\tfixture\\n';
  if (command === 'tar') {
    writeFileSync(args[1], 'fresh-archive');
    truncateSync(args[1], Number(process.env.O8_SIZE_TEST_ARCHIVE));
    return '';
  }
  throw new Error('PLATFORM_BOUNDARY_REACHED');
}`;
      writeFileSync(join(f.root, 'loader.mjs'), `export async function load(url, context, nextLoad) {
  return url === 'node:child_process' ? { format: 'module', shortCircuit: true, source: ${JSON.stringify(childProcess)} } : nextLoad(url, context);
}`);
      writeFileSync(join(f.root, 'register.mjs'), "import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));");
      const ceilings = FOOTPRINT_BUDGET.regressionCeilings;
      const result = spawnSync(process.execPath, ['--import', join(f.root, 'register.mjs'), join(sourceRoot, 'scripts/sign-and-notarize.mjs')], {
        cwd: f.root, encoding: 'utf8', timeout: 10_000,
        env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: f.root, TMPDIR: f.root,
          APPLE_SIGNING_IDENTITY: 'fixture', APPLE_ID: 'fixture', APPLE_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture',
          O8_SIZE_TEST_LOG: log, O8_SIZE_TEST_KIB: String(scenario === 'bundle' ? ceilings.appBundleBytes / 1024 + 1 : 8),
          O8_SIZE_TEST_ARCHIVE: String(scenario === 'archive' ? ceilings.updaterArchiveBytes + 1 : 16) },
      });
      expect(result.status).toBe(1);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string });
      if (scenario === 'safe') {
        expect(result.stderr).toContain('PLATFORM_BOUNDARY_REACHED');
        expect(calls.at(-1)?.command).toBe('codesign');
      } else {
        expect(result.stderr).toContain(scenario === 'cache' || scenario === 'dev' ? `contains .next/${scenario}`
          : scenario === 'bundle' ? 'appBundleBytes' : 'updaterArchiveBytes');
        expect(calls.every(call => ['cat', 'du', 'tar'].includes(call.command))).toBe(true);
      }
      expect(readdirSync(f.root).filter(name => name.startsWith('o8-package-size-'))).toEqual([]);
    },
  );
});
