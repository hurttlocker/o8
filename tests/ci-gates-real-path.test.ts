import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repo = process.cwd();
const workflow = parse(readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8'));
const root = mkdtempSync(path.join(tmpdir(), 'o8-ci-gates-'));
const nativeScript = path.join(repo, 'scripts/ci/native-changes.mjs');

afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'CI Fixture');
git('config', 'user.email', 'fixture@example.invalid');
writeFileSync(path.join(root, 'README.md'), 'fixture\n');
git('add', '.');
git('commit', '-qm', 'fixture base');
const base = git('rev-parse', 'HEAD');

function commit(file: string, remove = false): string {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  if (remove) rmSync(target);
  else writeFileSync(target, `${git('rev-parse', 'HEAD')}\n`);
  git('add', '--', file);
  git('commit', '-qm', 'fixture change');
  return git('rev-parse', 'HEAD');
}

function select(eventName: string, event: object): string {
  const eventPath = path.join(root, 'event.json');
  const outputPath = path.join(root, 'output.txt');
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(outputPath, '');
  // Execute the selector command wired into each required job, from a real
  // committed fixture repository; no GitHub API or native build is involved.
  for (const id of ['rust-check-linux', 'rust-check-windows']) {
    const step = workflow.jobs[id].steps.find((entry: { id?: string }) => entry.id === 'native');
    expect(step, `${id} must select inputs inside the required job`).toBeDefined();
    const command = step.run.replace('scripts/ci/native-changes.mjs', nativeScript);
    const result = spawnSync(command, {
      shell: true,
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    });
    expect(result.status, result.stderr).toBe(0);
  }
  const outputs = readFileSync(outputPath, 'utf8').trim().split('\n');
  expect(outputs).toHaveLength(2);
  expect(outputs[0]).toBe(outputs[1]);
  return outputs[0];
}

function condition(source: string, github: object, needs: object = {}): boolean {
  const expression = source.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('needs.test-shards', 'needs["test-shards"]');
  return Boolean(new Function('github', 'inputs', 'needs', 'always', `return (${expression});`)(
    github, { integration_base: '' }, needs, () => true,
  ));
}

describe('required CI gates through workflow commands', () => {
  it('keeps the merge-group trigger and the eight required check names', () => {
    expect(workflow.on.merge_group).toEqual({ types: ['checks_requested'], branches: ['main'] });
    const required = {
      typecheck: 'Type Check', lint: 'Lint', test: 'Hermetic Unit Tests', security: 'Security Audit',
      'governance-smoke': 'Governance Smoke', 'rust-check-linux': 'Rust Compile Gate (Linux)',
      'rust-check-windows': 'Rust Compile Gate (Windows)', 'integration-changed': 'Integration Tests (changed files)',
    };
    for (const [id, name] of Object.entries(required)) {
      expect(workflow.jobs[id].name).toBe(name);
      for (const event_name of ['pull_request', 'merge_group']) {
        expect(condition(workflow.jobs[id].if, { event_name, event: {} }, {
          'test-shards': { result: 'success' },
        }), `${id} must report on ${event_name}`).toBe(true);
      }
    }
  });

  it('skips compile work for TypeScript-only PRs and main pushes', () => {
    const head = commit('src/fixture.ts');
    expect(select('pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }))
      .toBe('changed=false');
    expect(select('push', { before: base, after: head })).toBe('changed=false');
  });

  it.each(['src-tauri/src/fixture.rs', 'crates/fixture/Cargo.toml', 'Cargo.lock',
    '.cargo/config.toml', 'rust-toolchain.toml', 'src-tauri/tauri.conf.json',
    'src-tauri/capabilities/fixture.json', 'tauri-plugin-mcp/src/fixture.rs',
    'tests/fixtures/update-ping-native/src/lib.rs', 'scripts/test-update-ping-native.mjs',
    '.github/workflows/ci.yml', 'scripts/ci/native-changes.mjs'])('compiles when %s changes', (file) => {
    const before = git('rev-parse', 'HEAD');
    const head = commit(file);
    expect(select('push', { before, after: head })).toBe('changed=true');
  });

  it('covers every queued commit but ignores an unrelated later checkout', () => {
    const queueBase = git('rev-parse', 'HEAD');
    commit('src/queued.ts');
    const head = commit('src-tauri/src/queued.rs');
    const group = { base_sha: queueBase, head_sha: head };
    commit('src/later.ts');
    expect(select('merge_group', { merge_group: group })).toBe('changed=true');
    expect(select('merge_group', { merge_group: { base_sha: head, head_sha: head } })).toBe('changed=false');
  });

  it('compares PRs from their merge base, excluding base-branch-only native changes', () => {
    const fork = git('rev-parse', 'HEAD');
    const head = commit('src/pr-only.ts');
    git('checkout', '-qb', 'fixture/upstream', fork);
    const upstream = commit('src-tauri/src/base-only.rs');
    expect(select('pull_request', { pull_request: { base: { sha: upstream }, head: { sha: head } } }))
      .toBe('changed=false');
    git('checkout', '-q', 'main');
  });

  it('detects deleted and renamed native inputs', () => {
    const before = commit('src-tauri/src/removed.rs');
    const deleted = commit('src-tauri/src/removed.rs', true);
    expect(select('push', { before, after: deleted })).toBe('changed=true');
    const renameBase = commit('crates/fixture/Cargo.lock');
    git('mv', 'crates/fixture/Cargo.lock', 'crates/fixture/old-lock.txt');
    git('commit', '-qm', 'fixture rename');
    expect(select('push', { before: renameBase, after: git('rev-parse', 'HEAD') })).toBe('changed=true');
  });

  it('forces manual runs and fails safe when comparison refs are unavailable', () => {
    expect(select('workflow_dispatch', {})).toBe('changed=true');
    expect(select('push', { before: '0'.repeat(40), after: base })).toBe('changed=true');
    expect(select('pull_request', { pull_request: { base: { sha: 'missing' }, head: { sha: base } } }))
      .toBe('changed=true');
  });

  it('guards all expensive native steps while leaving each required job enabled', () => {
    for (const id of ['rust-check-linux', 'rust-check-windows']) {
      const steps = workflow.jobs[id].steps;
      expect(steps[0].uses).toBe('actions/checkout@v4');
      expect(steps[0].with['fetch-depth']).toBe(0);
      expect(steps[0].with.filter).toBe('blob:none');
      expect(steps[1].id).toBe('native');
      for (const step of steps.slice(2)) expect(step.if).toBe("steps.native.outputs.changed == 'true'");
      const cache = steps.find((step: { uses?: string }) => step.uses?.startsWith('Swatinem/rust-cache@'));
      expect(cache.with['save-if']).toBe("${{ github.ref == 'refs/heads/main' }}");
    }
  });

  it('runs four independent shards and fails the stable aggregate on every non-success', () => {
    const shards = workflow.jobs['test-shards'];
    expect(shards.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } });
    expect(workflow.jobs.test.needs).toEqual(['test-shards']);
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      expect(condition(workflow.jobs.test.if, { event: {} }, { 'test-shards': { result } })).toBe(true);
      const step = workflow.jobs.test.steps[0];
      const run = spawnSync(step.run, {
        shell: true, encoding: 'utf8',
        env: { ...process.env, SHARD_RESULT: result },
      });
      expect(run.status).toBe(result === 'success' ? 0 : 1);
    }
    const monday = { event: { schedule: '41 13 * * 1' } };
    expect(condition(shards.if, monday)).toBe(false);
    expect(condition(workflow.jobs.test.if, monday, { 'test-shards': { result: 'skipped' } })).toBe(false);
    expect(workflow.jobs['integration-weekly'].needs).toBe('test');
  });

  it('restores lint and typecheck caches, refreshing them only on main', () => {
    for (const id of ['lint', 'typecheck']) {
      const steps = workflow.jobs[id].steps;
      const restore = steps.find((step: { uses?: string }) => step.uses === 'actions/cache/restore@v4');
      const save = steps.find((step: { uses?: string }) => step.uses === 'actions/cache/save@v4');
      expect(restore?.with.path).toBe(id === 'lint' ? '.cache/eslint' : 'tsconfig.tsbuildinfo');
      expect(restore.with['restore-keys']).toBeTruthy();
      expect(save?.with.path).toBe(restore.with.path);
      expect(save.if).toContain("github.ref == 'refs/heads/main'");
    }
    expect(workflow.jobs.lint.steps.some((step: { run?: string }) =>
      step.run?.includes('--cache --cache-strategy content --cache-location .cache/eslint'))).toBe(true);
  });

  it('proves the actual shard union equals the unsharded hermetic entry point', () => {
    const result = spawnSync(process.execPath, ['scripts/ci/check-hermetic-shards.mjs'], {
      cwd: repo, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toMatch(/\d+ files, 4 shards, 0 missing, 0 duplicates, 0 extra/);
  }, 60_000);
});
