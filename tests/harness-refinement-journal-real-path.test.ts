import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { advanceExperiment, createExperiment, revokeExperimentLesson, settleExperiment } from '@/lib/harness/improvement/engine';
import { createImprovementJournal } from '@/lib/harness/improvement/journal';
import type { ImprovementManifest, ImprovementReceipt } from '@/lib/harness/improvement/types';
import { digest } from '@/lib/harness/improvement/validation';

const roots: string[] = [];
function fixture(): { root: string; directory: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'o8-refinement-journal-'));
  roots.push(root);
  return { root, directory: join(root, 'journal') };
}
const manifest = (): ImprovementManifest => ({
  id: 'isolated-trial', repository: 'fixture-repository', baselineRevision: 'a'.repeat(40),
  contractDigest: 'b'.repeat(64), verifierDigest: 'c'.repeat(64), permissionsDigest: 'd'.repeat(64),
  runtime: 'codex', model: 'fixture-model', effort: 'high', provenance: 'fixture', mode: 'parallel', k: 1,
  maxStages: 30, maxStageWallMs: 1000, maxInputBytes: 100000,
  baseline: { instructions: 'Preserve immutable permission and review boundaries.' },
  tasks: [{ id: 'A', domain: 'code', prompt: 'Implement the isolated fixture.' }],
});
function completed(state: ReturnType<typeof createExperiment>): ImprovementReceipt {
  return {
    requestId: state.pending!.id, requestDigest: digest(state.pending), status: 'completed', provenance: 'fixture',
    runtime: 'codex', model: 'fixture-model', effort: 'high', artifact: 'A fixture artifact.', trajectory: 'Fixture observations.',
    usage: { attempts: 1, inputTokens: null, outputTokens: null, actualUsd: null, estimatedUsd: null,
      wallMs: 1, humanMs: null, billing: 'unknown' },
  };
}
function experimentDirectory(directory: string): string { return join(directory, digest(manifest().id)); }
function revisions(directory: string): string[] {
  return readdirSync(experimentDirectory(directory)).filter((name) => /^\d{6}\.json$/.test(name)).sort();
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('durable refinement journal through isolated filesystem resources', () => {
  it('persists private immutable revisions and retrieves a pending reservation after reopening', () => {
    const { directory } = fixture();
    const journal = createImprovementJournal(directory);
    const initial = createExperiment(manifest());
    expect(journal.read(initial.manifest.id)).toBeNull();
    expect(existsSync(directory)).toBe(false);
    journal.append(initial, null);
    const pending = advanceExperiment(initial);
    journal.append(pending, initial.revision);
    expect(createImprovementJournal(directory).read(initial.manifest.id)).toEqual(pending);
    expect(revisions(directory)).toEqual(['000000.json', '000001.json']);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(experimentDirectory(directory)).mode & 0o777).toBe(0o700);
    for (const name of revisions(directory)) {
      const stat = lstatSync(join(experimentDirectory(directory), name));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.nlink).toBe(1);
    }
    const settled = settleExperiment(pending, completed(pending));
    createImprovementJournal(directory).append(settled, pending.revision);
    expect(journal.read(initial.manifest.id)).toEqual(settled);
  });

  it('rejects stale writers, duplicate initialization and skipped revisions without overwriting', () => {
    const { directory } = fixture();
    const first = createImprovementJournal(directory);
    const second = createImprovementJournal(directory);
    const initial = createExperiment(manifest());
    first.append(initial, null);
    const pending = advanceExperiment(initial);
    first.append(pending, 0);
    expect(() => second.append(pending, 0)).toThrow(/revision|conflict/i);
    expect(() => second.append(initial, null)).toThrow(/revision|conflict/i);
    expect(() => second.append({ ...pending, revision: 3 }, 1)).toThrow(/revision|transition|replay/i);
    expect(first.read(initial.manifest.id)).toEqual(pending);
    expect(revisions(directory)).toHaveLength(2);
  });

  it('retains uncertain pending state across restart and will not permit a forged reset', () => {
    const { directory } = fixture();
    const journal = createImprovementJournal(directory);
    const initial = createExperiment(manifest()); journal.append(initial, null);
    const pending = advanceExperiment(initial); journal.append(pending, 0);
    const observation = completed(pending); delete observation.artifact; delete observation.trajectory;
    const uncertain = settleExperiment(pending, { ...observation, status: 'uncertain' });
    journal.append(uncertain, 1);
    const restored = createImprovementJournal(directory).read(initial.manifest.id)!;
    expect(restored.status).toBe('blocked');
    expect(restored.pending?.id).toBe(pending.pending?.id);
    expect(advanceExperiment(restored)).toEqual(restored);
    expect(() => journal.append({ ...restored, status: 'ready', pending: null, revision: 3 }, 2)).toThrow();
    expect(journal.read(initial.manifest.id)).toEqual(uncertain);
  });

  it('rejects forged authority, changed manifests and unsupported state at the public append API', () => {
    const { directory } = fixture(); const journal = createImprovementJournal(directory);
    const initial = createExperiment(manifest()); journal.append(initial, null);
    const pending = advanceExperiment(initial);
    expect(() => journal.append({ ...pending, acceptance: { liveBenefitProven: true, promoted: true } } as never, 0)).toThrow();
    expect(() => journal.append({ ...pending, extra: 'untrusted field' } as never, 0)).toThrow();
    const changed = advanceExperiment(createExperiment({ ...manifest(), model: 'different-model' }));
    expect(() => journal.append(changed, 0)).toThrow(/binding|manifest|transition|contract/i);
    expect(journal.read(initial.manifest.id)).toEqual(initial);
  });

  it('fails closed on corruption, a missing revision and uncommitted scratch without deleting them', () => {
    const { directory } = fixture(); const journal = createImprovementJournal(directory);
    const initial = createExperiment(manifest()); journal.append(initial, null);
    const pending = advanceExperiment(initial); journal.append(pending, 0);
    const target = join(experimentDirectory(directory), '000001.json');
    const original = readFileSync(target, 'utf8');
    writeFileSync(target, '{truncated', { mode: 0o600 });
    expect(() => journal.read(initial.manifest.id)).toThrow();
    expect(() => journal.append(pending, 0)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{truncated');
    writeFileSync(target, original);
    renameSync(target, join(experimentDirectory(directory), '000002.json'));
    expect(() => journal.read(initial.manifest.id)).toThrow(/gap|sequence|revision/i);
    renameSync(join(experimentDirectory(directory), '000002.json'), target);
    const scratch = join(experimentDirectory(directory), '.pending-interrupted.json');
    writeFileSync(scratch, 'interrupted', { mode: 0o600 });
    expect(() => journal.read(initial.manifest.id)).toThrow(/uncertain|uncommitted|unexpected/i);
    expect(readFileSync(scratch, 'utf8')).toBe('interrupted');
  });

  it('rejects symlink roots, ancestors, experiment directories and revision files', () => {
    const { root, directory } = fixture();
    const external = join(root, 'external'); mkdirSync(external, { mode: 0o700 });
    symlinkSync(external, directory);
    expect(() => createImprovementJournal(directory).append(createExperiment(manifest()), null)).toThrow(/symlink|directory|unsafe/i);
    expect(() => createImprovementJournal(join(directory, 'nested')).append(createExperiment(manifest()), null)).toThrow(/symlink|directory|unsafe/i);
    expect(readdirSync(external)).toEqual([]);
    rmSync(directory);
    const journal = createImprovementJournal(directory); const initial = createExperiment(manifest()); journal.append(initial, null);
    const experiment = experimentDirectory(directory); renameSync(experiment, join(root, 'saved'));
    symlinkSync(join(root, 'saved'), experiment);
    expect(() => journal.read(initial.manifest.id)).toThrow(/symlink|directory|unsafe/i);
    rmSync(experiment); renameSync(join(root, 'saved'), experiment);
    const target = join(experiment, '000000.json'); renameSync(target, join(root, 'saved.json'));
    symlinkSync(join(root, 'saved.json'), target);
    expect(() => journal.read(initial.manifest.id)).toThrow(/symlink|regular|unsafe/i);
    expect(() => journal.append(advanceExperiment(initial), 0)).toThrow();
  });

  it('refuses public storage permissions instead of silently repairing user files', () => {
    const { directory } = fixture(); const initial = createExperiment(manifest());
    mkdirSync(directory, { mode: 0o755 });
    expect(() => createImprovementJournal(directory).append(initial, null)).toThrow(/private|permission/i);
    expect(lstatSync(directory).mode & 0o777).toBe(0o755);
    chmodSync(directory, 0o700);
    const journal = createImprovementJournal(directory); journal.append(initial, null);
    const target = join(experimentDirectory(directory), '000000.json'); chmodSync(target, 0o644);
    expect(() => journal.read(initial.manifest.id)).toThrow(/private|permission/i);
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
  });

  it('rejects a special-file revision before opening it and does not block on a FIFO', () => {
    const { directory } = fixture(); const journal = createImprovementJournal(directory);
    const initial = createExperiment(manifest()); journal.append(initial, null);
    const target = join(experimentDirectory(directory), '000000.json');
    renameSync(target, `${target}.saved`);
    execFileSync('mkfifo', ['-m', '600', target]);
    expect(() => journal.read(initial.manifest.id)).toThrow(/regular|unsafe|unexpected/i);
  });

  it('enforces snapshot, total-byte and revision bounds before publishing another revision', () => {
    const { directory } = fixture(); const initial = createExperiment(manifest());
    expect(() => createImprovementJournal(directory, { maxSnapshotBytes: 512 }).append(initial, null)).toThrow(/byte|size|budget/i);
    const journal = createImprovementJournal(directory, { maxRevisions: 1 }); journal.append(initial, null);
    expect(() => journal.append(advanceExperiment(initial), 0)).toThrow(/revision|budget/i);
    expect(revisions(directory)).toHaveLength(1);
    const bytes = lstatSync(join(experimentDirectory(directory), '000000.json')).size;
    expect(() => createImprovementJournal(directory, { maxJournalBytes: bytes + 1 }).append(advanceExperiment(initial), 0)).toThrow(/byte|size|budget/i);
    expect(createImprovementJournal(directory).read(initial.manifest.id)).toEqual(initial);
  });

  it('rejects hash-valid poisoned state and detached hard links on read', () => {
    const { root, directory } = fixture(); const journal = createImprovementJournal(directory);
    const initial = createExperiment(manifest()); journal.append(initial, null);
    const target = join(experimentDirectory(directory), '000000.json');
    const original = readFileSync(target, 'utf8');
    const envelope = JSON.parse(original);
    envelope.state.acceptance.promoted = true;
    const payload = { schema: envelope.schema, previousDigest: envelope.previousDigest, state: envelope.state };
    writeFileSync(target, JSON.stringify({ ...payload, digest: digest(payload) }));
    expect(() => journal.read(initial.manifest.id)).toThrow(/state|receipt|experiment/i);
    writeFileSync(target, original);
    linkSync(target, join(root, 'external-link.json'));
    expect(() => journal.read(initial.manifest.id)).toThrow(/single-link|regular|unsafe/i);
  });

  it('retrieves the same pending reservation in a fresh Node process', () => {
    const { root, directory } = fixture(); const journal = createImprovementJournal(directory);
    const initial = createExperiment(manifest()); journal.append(initial, null);
    const pending = advanceExperiment(initial); journal.append(pending, 0);
    const script = join(root, 'restart.cts');
    const modulePath = resolve('src/lib/harness/improvement/journal.ts');
    writeFileSync(script, `const { createImprovementJournal } = require(${JSON.stringify(modulePath)});
      process.stdout.write(JSON.stringify(createImprovementJournal(process.argv[2]).read(process.argv[3])));`);
    const restored = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', script, directory, initial.manifest.id], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    }));
    expect(restored).toEqual(pending);
    expect(restored.pending.id).toBe(pending.pending!.id);
    expect(restored.acceptance).toEqual({ liveBenefitProven: false, promoted: false });
  });

  it('admits exactly one of two process writers at the same expected revision', async () => {
    const { root, directory } = fixture(); const journal = createImprovementJournal(directory);
    const initial = createExperiment(manifest()); journal.append(initial, null);
    const pending = advanceExperiment(initial);
    const statePath = join(root, 'pending.json'); writeFileSync(statePath, JSON.stringify(pending));
    const script = join(root, 'writer.cts');
    const modulePath = resolve('src/lib/harness/improvement/journal.ts');
    writeFileSync(script, `import { readFileSync } from 'node:fs';
      const { createImprovementJournal } = require(${JSON.stringify(modulePath)});
      const state = JSON.parse(readFileSync(process.argv[3], 'utf8'));
      const journal = createImprovementJournal(process.argv[2]);
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => {
        try { journal.append(state, 0); process.stdout.write('committed'); }
        catch (error) { process.stdout.write('rejected:' + error.message); }
        process.stdin.destroy();
      });`);
    const writers = [0, 1].map(() => {
      const child = spawn(process.execPath, ['--import', 'tsx', script, directory, statePath], {
        cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
      });
      let output = ''; let errors = '';
      const ready = new Promise<void>((resolveReady, reject) => {
        child.stdout.on('data', (chunk) => { output += String(chunk); if (output.includes('ready\n')) resolveReady(); });
        child.stderr.on('data', (chunk) => { errors += String(chunk); });
        child.on('error', reject);
        child.on('exit', () => { if (!output.includes('ready\n')) reject(new Error(errors || 'Writer exited before ready.')); });
      });
      const done = new Promise<{ code: number | null; output: string; errors: string }>((resolveDone) => {
        child.on('close', (code) => resolveDone({ code, output, errors }));
      });
      return { child, ready, done };
    });
    try {
      await Promise.all(writers.map((writer) => writer.ready));
      for (const writer of writers) writer.child.stdin.end('go');
      const results = await Promise.all(writers.map((writer) => writer.done));
      for (const result of results) expect(result.code, result.errors).toBe(0);
      expect(results.filter((result) => result.output.endsWith('committed'))).toHaveLength(1);
      expect(results.filter((result) => result.output.includes('rejected:'))).toHaveLength(1);
      expect(journal.read(initial.manifest.id)).toEqual(pending);
      expect(revisions(directory)).toEqual(['000000.json', '000001.json']);
      expect(readdirSync(experimentDirectory(directory))).toHaveLength(2);
    } finally {
      for (const writer of writers) if (writer.child.exitCode === null) writer.child.kill();
      await Promise.all(writers.map((writer) => writer.done));
    }
  });

  it('persists an exact revocation transition, preserves history, and excludes the lesson after restart', () => {
    const { directory } = fixture(); const journal = createImprovementJournal(directory);
    const config = manifest();
    config.tasks.push({ id: 'B', domain: 'code', prompt: 'Inspect a second independent fixture.' });
    let state = createExperiment(config); journal.append(state, null);
    while (state.taskIndex === 0) {
      const pending = advanceExperiment(state); journal.append(pending, state.revision);
      const receipt = completed(pending); const request = pending.pending!;
      if (request.kind !== 'execute') { delete receipt.artifact; delete receipt.trajectory; }
      if (request.kind.startsWith('propose_') || request.kind === 'compose') {
        receipt.harness = { instructions: `${request.harness.instructions} ${request.label} fixture refinement.` };
      }
      if (request.kind === 'select') receipt.choice = request.choices[0]!.id;
      if (request.kind === 'compose' || request.kind === 'reflect') {
        const sourceRequestIds = [request.evidence.find((row) => row.label.startsWith('baseline'))!.requestId,
          request.evidence.find((row) => !row.label.startsWith('baseline'))!.requestId];
        if (request.kind === 'compose') receipt.decisions = [{ action: 'revise', rationale: 'Fixture behavioral contrast.', sourceRequestIds }];
        else receipt.lesson = { text: 'A fixture lesson to withdraw.', sourceRequestIds, expiresAfterTask: 1 };
      }
      state = settleExperiment(pending, receipt); journal.append(state, pending.revision);
    }
    expect(state.lessons).toHaveLength(1);
    const original = structuredClone(state);
    const files = revisions(directory).map((name) => ({ name, content: readFileSync(join(experimentDirectory(directory), name), 'utf8') }));
    const revoked = revokeExperimentLesson(state, state.lessons[0]!.id, 'The fixture lesson was contradicted.');
    journal.append(revoked, state.revision);
    for (const file of files) expect(readFileSync(join(experimentDirectory(directory), file.name), 'utf8')).toBe(file.content);
    state = createImprovementJournal(directory).read(state.manifest.id)!;
    expect(state).toEqual(revoked);
    expect(state.records).toEqual(original.records);
    expect(state.lessonRevocations[0]!.lessonDigest).toBe(digest(original.lessons[0]));
    const repeated = revokeExperimentLesson(state, state.lessons[0]!.id, 'The fixture lesson was contradicted.');
    expect(repeated.revision).toBe(state.revision);
    expect(() => journal.append(repeated, state.revision)).toThrow(/revision/i);
    const erased = structuredClone(original); erased.revision = state.revision + 1;
    expect(() => journal.append(erased, state.revision)).toThrow(/transition/i);
    const altered = advanceExperiment(state); altered.lessonRevocations[0]!.reason = 'Rewrite history.';
    expect(() => journal.append(altered, state.revision)).toThrow(/transition/i);
    let next = advanceExperiment(state); journal.append(next, state.revision); state = next;
    next = settleExperiment(state, completed(state)); journal.append(next, state.revision); state = next;
    next = advanceExperiment(state); journal.append(next, state.revision);
    const restored = createImprovementJournal(directory).read(state.manifest.id)!;
    expect(restored.pending!.kind).toBe('propose_invariant');
    expect(restored.pending!.taskId).toBe('B');
    expect(restored.pending!.lessons).toEqual([]);
    expect(restored.lessons[0]!.revoked).toBe(true);
    expect(restored.lessonRevocations).toHaveLength(1);
  });

  it('uses a digest key so traversal-like experiment identifiers never become paths', () => {
    const { root, directory } = fixture(); const journal = createImprovementJournal(directory);
    const initial = createExperiment({ ...manifest(), id: '../outside' }); journal.append(initial, null);
    expect(journal.read('../outside')).toEqual(initial);
    expect(readdirSync(directory)).toEqual([digest('../outside')]);
    expect(existsSync(join(root, 'outside'))).toBe(false);
  });
});
