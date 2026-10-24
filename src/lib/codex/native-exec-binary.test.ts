import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexNativeExecBinary } from './native-exec-binary';

const roots: string[] = [];
function fixture(version = '0.163.0') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-codex-native-'));
  roots.push(root);
  mkdirSync(path.join(root, 'bin'));
  const entry = path.join(root, 'bin', 'codex.js');
  writeFileSync(entry, 'fixture');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version, bin: { codex: 'bin/codex.js' } }));
  return { root, entry };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('Codex exec payload compatibility boundary', () => {
  it('preserves custom binaries and relative paths', async () => {
    for (const binary of ['codex', '/missing/custom-codex', process.execPath]) {
      expect(await codexNativeExecBinary(binary)).toBe(binary);
    }
  });

  it('preserves future npm launchers', async () => {
    const { entry } = fixture('0.164.0');
    expect(await codexNativeExecBinary(entry)).toBe(entry);
  });

  it('preserves the launcher when its payload is absent', async () => {
    const { entry } = fixture();
    expect(await codexNativeExecBinary(entry)).toBe(entry);
  });

  it.skipIf(process.platform === 'win32')('selects the platform alias only when its version matches the selected npm package', async () => {
    const { entry, root } = fixture();
    const suffix = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
    const platformRoot = path.join(root, 'node_modules', '@openai', `codex-${suffix}`);
    const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
    const payload = path.join(platformRoot, 'vendor', target, 'bin', 'codex');
    mkdirSync(path.dirname(payload), { recursive: true });
    writeFileSync(payload, 'fixture', { mode: 0o700 });
    const manifest = path.join(platformRoot, 'package.json');
    writeFileSync(manifest, JSON.stringify({ name: '@openai/codex', version: `0.163.0-${suffix}` }));
    expect(await codexNativeExecBinary(entry)).toBe(realpathSync(payload));
    writeFileSync(manifest, JSON.stringify({ name: '@openai/codex', version: `0.162.0-${suffix}` }));
    expect(await codexNativeExecBinary(entry)).toBe(entry);
    writeFileSync(manifest, JSON.stringify({ name: '@openai/codex', version: `0.163.0-${suffix}` }));
    chmodSync(payload, 0o600);
    expect(await codexNativeExecBinary(entry)).toBe(entry);
  });
});
