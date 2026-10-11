import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReleaseChannel } from '../scripts/lib/release-channel.mjs';

const roots: string[] = [];
const releaseScript = join(process.cwd(), 'scripts/release.mjs');
const speechBuildScript = join(process.cwd(), 'scripts/build-speech-local.mjs');
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function thinMachO(cpuType: number) {
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(cpuType, 4);
  return binary;
}

function universalMachO() {
  const slices = [thinMachO(CPU_TYPE_X86_64), thinMachO(CPU_TYPE_ARM64)];
  const binary = Buffer.alloc(8 + slices.length * 20 + slices.reduce((sum, slice) => sum + slice.length, 0));
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(slices.length, 4);
  let offset = 8 + slices.length * 20;
  slices.forEach((slice, index) => {
    const entry = 8 + index * 20;
    binary.writeUInt32BE(index === 0 ? CPU_TYPE_X86_64 : CPU_TYPE_ARM64, entry);
    binary.writeUInt32BE(offset, entry + 8);
    binary.writeUInt32BE(slice.length, entry + 12);
    slice.copy(binary, offset);
    offset += slice.length;
  });
  return binary;
}

function infoPlist(version: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>o8</string>
<key>CFBundleIdentifier</key><string>run.o8.app</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>\n`;
}

function configureUpdaterSignature(root: string, archive: string, signaturePath: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.from('o8fixtur');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicPacket = Buffer.concat([Buffer.from('Ed'), keyId, publicDer.subarray(-32)]);
  const standardPublicKey = `untrusted comment: fixture updater key\n${publicPacket.toString('base64')}\n`;
  const publicKeyConfig = Buffer.from(standardPublicKey).toString('base64');
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({
    plugins: { updater: { pubkey: publicKeyConfig } },
  }));

  const message = createHash('blake2b512').update(readFileSync(archive)).digest();
  const signaturePacket = Buffer.concat([Buffer.from('ED'), keyId, sign(null, message, privateKey)]);
  const standardSignature = `untrusted comment: fixture updater signature\n${signaturePacket.toString('base64')}\n`;
  writeFileSync(signaturePath, Buffer.from(standardSignature).toString('base64'));
}

function fixture(version = '0.1.741-preview.1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-release-channel-')));
  roots.push(root);
  const bundle = join(root, 'src-tauri/target/universal-apple-darwin/release/bundle');
  mkdirSync(join(bundle, 'macos'), { recursive: true });
  mkdirSync(join(bundle, 'dmg'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(bundle, 'dmg', `o8_${version}_universal.dmg`), 'fixture');
  for (const name of ['o8', 'speech_recognizer', 'speech-local', 'o8-pi-write']) {
    const path = join(bundle, 'macos', 'o8.app', 'Contents', 'MacOS', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, universalMachO());
  }
  writeFileSync(join(bundle, 'macos', 'o8.app', 'Contents', 'Info.plist'), infoPlist(version));
  const archive = spawnSync('tar', ['czf', join(bundle, 'macos', 'o8.app.tar.gz'), '-C', join(bundle, 'macos'), 'o8.app']);
  if (archive.status !== 0) throw new Error(`failed to create updater fixture: ${archive.stderr}`);
  configureUpdaterSignature(
    root,
    join(bundle, 'macos', 'o8.app.tar.gz'),
    join(bundle, 'macos', 'o8.app.tar.gz.sig'),
  );
  const dmgApp = join(root, 'dmg-fixture', 'o8.app');
  mkdirSync(join(dmgApp, '..'), { recursive: true });
  cpSync(join(bundle, 'macos', 'o8.app'), dmgApp, { recursive: true, preserveTimestamps: true });
  const log = join(root, 'effects.jsonl');
  const prelude = `import { appendFileSync } from 'node:fs';
const record = (name, args = []) => appendFileSync(process.env.O8_CHANNEL_TEST_LOG, JSON.stringify({name, args}) + '\\n');`;
  const childProcess = `${prelude}
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const realChildProcess = process.getBuiltinModule('node:child_process');
export function execFileSync(command, args = [], options = {}) {
  if (command === 'tar') return realChildProcess.execFileSync(command, args, options);
  record(command, args);
  if (command.endsWith('hdiutil')) {
    if (args[0] === 'attach') {
      const mountpoint = args[args.indexOf('-mountpoint') + 1];
      cpSync(process.env.O8_CHANNEL_TEST_DMG_APP, join(mountpoint, 'o8.app'), { recursive: true, preserveTimestamps: true });
      return '/dev/disk99';
    }
    return '';
  }
  if (command.endsWith('codesign')) return '';
  if (command.endsWith('plutil')) {
    const plist = readFileSync(args[args.length - 1], 'utf8');
    const value = plist.match(/<key>CFBundleShortVersionString<\\/key>\\s*<string>([^<]+)<\\/string>/)?.[1];
    if (!value) throw new Error('missing fixture version');
    return value + '\\n';
  }
  if (command === 'gh' && args[0] === 'release' && args[1] === 'view') {
    if (args.includes('--json')) return '2026-09-07T00:00:00Z';
    if (process.env.O8_CHANNEL_TEST_EXISTING === '1') return '{}';
    throw new Error('release not found');
  }
  if (command === 'gh' && args[1] === 'create' && args.includes('hurttlocker/o8-releases') && process.env.O8_CHANNEL_TEST_FAIL_MIRROR === '1') throw new Error('mirror unavailable');
  if (command === 'git' && args[0] === 'describe') return 'v' + process.env.O8_CHANNEL_TEST_VERSION;
  if (command === 'git' && args[0] === 'ls-remote') return 'a'.repeat(40) + '\\trefs/tags/v' + process.env.O8_CHANNEL_TEST_VERSION;
  if (command === 'git' && args[0] === 'log') return args.includes('--format=%H%x09%s') ? 'a'.repeat(40) + '\\tfix: improve workspace feedback' : 'fix: improve workspace feedback';
  return '';
}
export const spawn = () => { throw new Error('unexpected spawn'); };
export const spawnSync = spawn;`;
  const modules: Record<string, string> = {
    'node:child_process': childProcess,
    '/scripts/native-bundle.mjs': 'export function verifyNativeBundle() {}',
    '/scripts/sync-reports.mjs': `${prelude}\nexport async function syncReports() { record('syncReports'); return { status: 'disabled', fresh: [] }; }`,
    '/scripts/publish-fixed.mjs': `${prelude}\nexport async function publishFixed() { record('publishFixed'); }`,
    '/scripts/lib/fixed-reports.mjs': `${prelude}
export const releaseRange = () => 'HEAD~1..HEAD';
export function resolveNewFixes() { record('resolveNewFixes'); return { entries: [{ id: 'fixture-report' }], missing: [] }; }
export function readPublished() { record('readPublished'); return []; }
export const buildManifest = (fixed) => ({ fixed });`,
  };
  // Only platform/provider edges are simulated. The actual release entry point,
  // channel policy, manifest writer, and publication control flow run unchanged.
  writeFileSync(join(root, 'loader.mjs'), `const modules = ${JSON.stringify(modules)};
export async function load(url, context, nextLoad) {
  const key = Object.keys(modules).find(key => url === key || url.endsWith(key));
  return key ? { format: 'module', shortCircuit: true, source: modules[key] } : nextLoad(url, context);
}`);
  writeFileSync(join(root, 'register.mjs'), `${prelude}
import { register } from 'node:module';
register(new URL('./loader.mjs', import.meta.url));
globalThis.fetch = async () => { record('announceRelease'); return { ok: true }; };`);
  return { root, bundle, dmgApp, log, version };
}

function run(f: ReturnType<typeof fixture>, channel: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', join(f.root, 'register.mjs'), releaseScript, ...args], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      HOME: f.root,
      O8_DATA_DIR: join(f.root, 'data'),
      CORTEX_IDE_DATA_DIR: join(f.root, 'data'),
      O8_RELEASE_CHANNEL: channel,
      O8_CHANNEL_TEST_VERSION: f.version,
      O8_CHANNEL_TEST_LOG: f.log,
      O8_CHANNEL_TEST_DMG_APP: f.dmgApp,
      O8_RELEASES_WEBHOOK_URL: 'https://fixture.invalid/webhook',
      ...extraEnv,
    },
  });
}

function effects(f: ReturnType<typeof fixture>): Array<{ name: string; args: string[] }> {
  return existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

function expectNoPublicationMutation(f: ReturnType<typeof fixture>) {
  const calls = effects(f);
  expect(calls.some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1])))
    .toBe(false);
  expect(calls.some(c => ['syncReports', 'publishFixed', 'announceRelease', 'bash'].includes(c.name)))
    .toBe(false);
  expect(existsSync(join(f.bundle, 'macos', 'latest.json'))).toBe(false);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('release channels through the publication entry point', () => {
  it('publishes two immutable prereleases without reaching any stable surface', () => {
    const f = fixture();
    const result = run(f, 'preview');
    expect(result.status, result.stderr).toBe(0);
    const calls = effects(f);
    const creates = calls.filter(c => c.name === 'gh' && c.args[1] === 'create');
    expect(creates).toHaveLength(2);
    for (const call of creates) {
      expect(call.args).toContain('--prerelease');
      expect(call.args).toContain('--latest=false');
      expect(call.args).toContain(join(f.bundle, 'macos', 'preview.json'));
      expect(call.args.some(arg => arg.endsWith('/latest.json') || arg.endsWith('/fixed.json'))).toBe(false);
    }
    expect(calls.some(c => ['syncReports', 'resolveNewFixes', 'readPublished', 'publishFixed', 'announceRelease', 'bash'].includes(c.name))).toBe(false);
    expect(existsSync(join(f.bundle, 'macos', 'latest.json'))).toBe(false);
    expect(existsSync(join(f.bundle, 'macos', 'fixed.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.bundle, 'macos', 'preview.json'), 'utf8'))).toMatchObject({ version: f.version });
    expect(result.stdout).not.toContain('installed o8.app will pick up');
  });

  it('retains stable publication, receipts and announcements without pushing source archives', () => {
    const f = fixture('0.1.741');
    mkdirSync(join(f.root, 'release-notes'));
    writeFileSync(join(f.root, 'release-notes', 'next.md'), '- Improve workspace feedback.\n');
    const result = run(f, 'stable');
    expect(result.status, result.stderr).toBe(0);
    const calls = effects(f);
    expect(calls.filter(c => c.name === 'gh' && c.args[1] === 'create')).toHaveLength(2);
    expect(calls.some(c => c.args.includes('--prerelease'))).toBe(false);
    for (const name of ['syncReports', 'resolveNewFixes', 'publishFixed', 'announceRelease', 'bash']) {
      expect(calls.some(c => c.name === name), name).toBe(true);
    }
    expect(existsSync(join(f.bundle, 'macos', 'latest.json'))).toBe(true);
    expect(existsSync(join(f.bundle, 'macos', 'fixed.json'))).toBe(true);
    expect(existsSync(join(f.root, 'release-notes', 'next.md'))).toBe(true);
    expect(calls.some(c => c.name === 'git' && ['add', 'commit', 'push'].includes(c.args[0]))).toBe(false);
  });

  it('refuses publication when the app backing the arm64 updater entry is x86_64-only', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.bundle, 'macos', 'o8.app', 'Contents', 'MacOS', 'o8'), thinMachO(CPU_TYPE_X86_64));

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing required Mach-O architecture arm64');
    expect(effects(f).some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1])))
      .toBe(false);
    expect(existsSync(join(f.bundle, 'macos', 'latest.json'))).toBe(false);
  });

  it('refuses publication when the separately staged updater archive is thin', () => {
    const f = fixture('0.1.741');
    const main = join(f.bundle, 'macos', 'o8.app', 'Contents', 'MacOS', 'o8');
    writeFileSync(main, thinMachO(CPU_TYPE_X86_64));
    const archive = spawnSync('tar', ['czf', join(f.bundle, 'macos', 'o8.app.tar.gz'), '-C', join(f.bundle, 'macos'), 'o8.app']);
    if (archive.status !== 0) throw new Error(`failed to replace updater fixture: ${archive.stderr}`);
    writeFileSync(main, universalMachO());

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('archived Contents/MacOS/o8 is missing required Mach-O architecture arm64');
    expect(effects(f).some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1])))
      .toBe(false);
  });

  it('refuses publication when the separately staged updater archive is stale', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.bundle, 'macos', 'o8.app', 'Contents', 'release-identity.txt'), 'new build');

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('updater archive contents do not match the inspected macOS app bundle');
    expect(effects(f).some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1])))
      .toBe(false);
  });

  it('refuses publication when the updater signature is invalid', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.bundle, 'macos', 'o8.app.tar.gz.sig'), 'not-a-signature');

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('updater signature does not verify against the configured public key');
    expectNoPublicationMutation(f);
  });

  it('refuses publication when the signature covers stale updater bytes', () => {
    const f = fixture('0.1.741');
    const archivePath = join(f.bundle, 'macos', 'o8.app.tar.gz');
    const previousArchive = readFileSync(archivePath);
    const main = join(f.bundle, 'macos', 'o8.app', 'Contents', 'MacOS', 'o8');
    const changedTime = new Date('2026-09-29T12:00:00.000Z');
    utimesSync(main, changedTime, changedTime);
    const archive = spawnSync('tar', ['czf', archivePath, '-C', join(f.bundle, 'macos'), 'o8.app']);
    if (archive.status !== 0) throw new Error(`failed to replace updater fixture: ${archive.stderr}`);
    expect(readFileSync(archivePath)).not.toEqual(previousArchive);

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('updater signature does not verify against the configured public key');
    expectNoPublicationMutation(f);
  });

  it('refuses publication when the DMG app is thin', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.dmgApp, 'Contents', 'MacOS', 'o8'), thinMachO(CPU_TYPE_X86_64));

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DMG Contents/MacOS/o8 is missing required Mach-O architecture arm64');
    expectNoPublicationMutation(f);
  });

  it('refuses publication when the DMG app differs from the updater app', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.dmgApp, 'Contents', 'installer-only.txt'), 'stale installer');

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DMG app contents do not match the inspected macOS app bundle');
    expectNoPublicationMutation(f);
  });

  it.skipIf(process.platform !== 'darwin')('invalidates a stale universal speech helper when only the thin fallback succeeds', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-speech-fallback-')));
    roots.push(root);
    const scripts = join(root, 'scripts');
    const helpers = join(root, 'src-tauri', 'helpers');
    const armBuild = join(root, 'src-tauri', 'sidecars', 'speech-local', '.build', 'arm64-apple-macosx', 'release');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(helpers, { recursive: true });
    mkdirSync(armBuild, { recursive: true });
    copyFileSync(speechBuildScript, join(scripts, 'build-speech-local.mjs'));
    writeFileSync(join(helpers, 'speech-local'), 'old-generic');
    writeFileSync(join(helpers, 'speech-local-aarch64-apple-darwin'), 'old-arm');
    writeFileSync(join(helpers, 'speech-local-universal-apple-darwin'), 'old-universal');
    writeFileSync(join(helpers, 'speech-local-x86_64-apple-darwin'), 'old-intel');
    writeFileSync(join(armBuild, 'speech-local'), 'new-arm');
    writeFileSync(join(root, 'loader.mjs'), `export async function load(url, context, nextLoad) {
  if (url !== 'node:child_process') return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: \`export function execSync(command) {
    if (command.includes('arm64 --arch x86_64')) throw new Error('forced universal failure');
    return Buffer.from('');
  }\` };
}`);

    const result = spawnSync(process.execPath, ['--experimental-loader', join(root, 'loader.mjs'), join(scripts, 'build-speech-local.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, O8_TAURI_BUILD_TARGET: 'universal-apple-darwin' },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(join(helpers, 'speech-local'), 'utf8')).toBe('new-arm');
    expect(readFileSync(join(helpers, 'speech-local-aarch64-apple-darwin'), 'utf8')).toBe('new-arm');
    expect(readFileSync(join(helpers, 'speech-local-x86_64-apple-darwin'), 'utf8')).toBe('old-intel');
    expect(existsSync(join(helpers, 'speech-local-universal-apple-darwin'))).toBe(false);
  });

  it.each([
    ['stable', '0.1.741-preview.1', {}],
    ['preview', '0.1.741', {}],
    ['nightly', '0.1.741-preview.1', {}],
    ['preview', '0.1.741-preview.1', { O8_RELEASE_CLOBBER: '1' }],
  ])('rejects mismatched or unsafe %s publication before side effects', (channel, version, extraEnv) => {
    const f = fixture(version);
    const result = run(f, channel, [], extraEnv);
    expect(result.status).toBe(1);
    expect(effects(f)).toEqual([]);
  });

  it('prints a write-free preview plan through dry-run', () => {
    const f = fixture();
    const result = run(f, 'preview', ['--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ channel: 'preview', publishStableEffects: false, manifestName: 'preview.json' });
    expect(effects(f)).toEqual([]);
  });

  it('refuses manual stable announcements for a preview', () => {
    const f = fixture();
    expect(run(f, 'preview', ['--announce']).status).toBe(1);
    expect(effects(f)).toEqual([]);
  });

  it('refuses to replace an existing candidate', () => {
    const f = fixture();
    expect(run(f, 'preview', [], { O8_CHANNEL_TEST_EXISTING: '1' }).status).toBe(1);
    expect(effects(f).some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1]))).toBe(false);
  });

  it('reports mirror failure without claiming a usable preview', () => {
    const f = fixture();
    const result = run(f, 'preview', [], { O8_CHANNEL_TEST_FAIL_MIRROR: '1' });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Preview published for explicit');
    expect(effects(f).some(c => ['publishFixed', 'announceRelease', 'bash'].includes(c.name))).toBe(false);
  });

  it('keeps ordinary stable versions as the default policy', () => {
    expect(resolveReleaseChannel('0.1.741', {})).toMatchObject({ channel: 'stable', githubFlags: [], manifestName: 'latest.json' });
  });

  it('keeps the manual hosted fallback draft-only and preview-only', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain("github.ref_type == 'tag'");
    expect(workflow).toContain('O8_RELEASE_CHANNEL: preview');
    expect(workflow).toContain('needs: validate-preview');
    expect(workflow).toContain('Could not verify release absence.');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('releaseDraft: true');
    expect(workflow).toContain('prerelease: true');
    expect(workflow).not.toContain('schedule:');
  });
});
