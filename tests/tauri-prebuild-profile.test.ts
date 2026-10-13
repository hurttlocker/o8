import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = realpathSync(mkdtempSync(path.join(process.env.O8_TEST_FIXTURE_SWEEP_PARENT || os.tmpdir(), 'o8-prebuild-profile-')));
const source = readFileSync('scripts/tauri-prebuild.mjs', 'utf8');

describe('tauri prebuild production callsite profile selection', () => {
  it.each(['modern', 'legacy', 'both', 'neither'])('preserves %s explicit profile selection', kind => {
    const fixture = mkdtempSync(path.join(root, 'fixture-'));
    const scripts = path.join(fixture, 'scripts');
    const lib = path.join(scripts, 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    writeFileSync(path.join(scripts, 'tauri-prebuild.mjs'), source);
    writeFileSync(path.join(lib, 'release-config.mjs'), 'export function resolveReleaseConfig() { return {}; }');
    writeFileSync(path.join(lib, 'release-artifacts.mjs'), `
      export function collectReleaseArtifactRecipe() { return { head: 'fixture', recipeSha256: 'fixture' }; }
      export function verifyReleaseArtifactManifest() { return { reusable: true, manifest: { outputs: [] } }; }
      export function writeReleaseArtifactManifest() { throw new Error('Unexpected build'); }
    `);
    writeFileSync(path.join(lib, 'release-build-cache.mjs'), `
      export function createReleaseBuildCacheRunId() { return 'fixture'; }
      export function resolveReleaseBuildCacheRoot() { return 'fixture'; }
      export function writeReleaseBuildCachePhaseReceipt() {}
      export function finalizeReleaseBuildCacheReceipt() { return { receiptPath: 'fixture' }; }
      export function isReleaseBuildCacheSafetyError() { return false; }
      export function captureReleaseBuildCache() { throw new Error('Unexpected capture'); }
      export function collectReleaseBuildCacheIdentity() { throw new Error('Unexpected build'); }
      export function restoreReleaseBuildCache() { throw new Error('Unexpected restore'); }
    `);
    writeFileSync(path.join(scripts, 'preship-cleanup.mjs'), `
      import { writeFileSync } from 'node:fs';
      writeFileSync('profile-receipt.json', JSON.stringify({
        modern: process.env.O8_DATA_DIR, legacy: process.env.CORTEX_IDE_DATA_DIR
      }));
    `);
    writeFileSync(path.join(scripts, 'packaged-server-smoke.mjs'), 'process.exit(0);');
    const modern = path.join(fixture, 'modern-profile');
    const legacy = path.join(fixture, 'legacy-profile');
    mkdirSync(modern);
    mkdirSync(legacy);
    writeFileSync(path.join(modern, 'held'), 'modern evidence');
    writeFileSync(path.join(legacy, 'held'), 'legacy evidence');
    const env = { ...process.env };
    delete env.O8_DATA_DIR;
    delete env.CORTEX_IDE_DATA_DIR;
    delete env.CORTEX_IDE_DB_PATH;
    delete env.O8_RELEASE_CACHE_RUN_ID;
    delete env.O8_RELEASE_CACHE_PREBUILD_MARKER;
    if (kind === 'modern' || kind === 'both') env.O8_DATA_DIR = modern;
    if (kind === 'legacy' || kind === 'both') env.CORTEX_IDE_DATA_DIR = legacy;
    const result = spawnSync(process.execPath, [path.join(scripts, 'tauri-prebuild.mjs')],
      { cwd: fixture, env, encoding: 'utf8', timeout: 10_000 });
    writeFileSync(path.join(fixture, 'native-receipt.json'), JSON.stringify({
      pid: result.pid, exit: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    }, null, 2));
    expect(result.status, result.stderr).toBe(0);
    const selected = JSON.parse(readFileSync(path.join(fixture, 'profile-receipt.json'), 'utf8'));
    if (kind === 'neither') {
      expect(selected.modern).toBe(selected.legacy);
      expect(path.basename(selected.modern)).toMatch(/^o8-tauri-build-data-/);
      expect(existsSync(selected.modern)).toBe(false);
    } else expect(selected).toEqual({
      modern: kind === 'legacy' ? legacy : modern,
      legacy: kind === 'modern' ? modern : legacy,
    });
    expect(readFileSync(path.join(modern, 'held'), 'utf8')).toBe('modern evidence');
    expect(readFileSync(path.join(legacy, 'held'), 'utf8')).toBe('legacy evidence');
  });
});
