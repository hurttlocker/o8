import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReleaseChannel } from '../scripts/lib/release-channel.mjs';

const roots: string[] = [];
const releaseScript = join(process.cwd(), 'scripts/release.mjs');

function fixture(version = '0.1.741-preview.1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-release-channel-')));
  roots.push(root);
  const bundle = join(root, 'src-tauri/target/release/bundle');
  mkdirSync(join(bundle, 'macos'), { recursive: true });
  mkdirSync(join(bundle, 'dmg'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(bundle, 'dmg', `o8_${version}_x64.dmg`), 'fixture');
  writeFileSync(join(bundle, 'macos', 'o8.app.tar.gz'), 'fixture');
  writeFileSync(join(bundle, 'macos', 'o8.app.tar.gz.sig'), 'fixture-signature');
  const log = join(root, 'effects.jsonl');
  const prelude = `import { appendFileSync } from 'node:fs';
const record = (name, args = []) => appendFileSync(process.env.O8_CHANNEL_TEST_LOG, JSON.stringify({name, args}) + '\\n');`;
  const childProcess = `${prelude}
export function execFileSync(command, args = []) {
  record(command, args);
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
  return { root, bundle, log, version };
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
      O8_RELEASES_WEBHOOK_URL: 'https://fixture.invalid/webhook',
      ...extraEnv,
    },
  });
}

function effects(f: ReturnType<typeof fixture>): Array<{ name: string; args: string[] }> {
  return existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
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
