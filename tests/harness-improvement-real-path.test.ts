import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
const script = resolve('scripts/harness-improvement.mjs');
const fixture = JSON.parse(readFileSync('tests/fixtures/harness-improvement/admission.json', 'utf8'));
const canonical = (value: unknown): string => JSON.stringify(value, function (_key, entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry;
});
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function setup(edit?: (input: typeof fixture) => void) {
  const root = mkdtempSync(join(tmpdir(), 'o8-harness-admission-'));
  roots.push(root);
  const input = structuredClone(fixture);
  input.manifest.contractDigest = digest({
    generatorTerms: input.bundle.contracts[0].generatorTerms,
    evaluatorTerms: input.bundle.contracts[0].evaluatorTerms,
    acceptanceCriteria: input.bundle.contracts[0].acceptanceCriteria,
  });
  edit?.(input);
  for (const name of ['bundle', 'manifest', 'proposals']) writeFileSync(join(root, `${name}.json`), JSON.stringify(input[name]));
  const output = join(root, 'report.json');
  const args = [script, '--bundle', join(root, 'bundle.json'), '--manifest', join(root, 'manifest.json'),
    '--manifest-sha256', digest(input.manifest), '--proposals', join(root, 'proposals.json'), '--out', output];
  return { root, output, args, input };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('offline harness proposal admission command', () => {
  it('emits a deterministic advisory report without modifying inputs', () => {
    const { root, output, args } = setup();
    const before = readFileSync(join(root, 'bundle.json'), 'utf8');
    execFileSync(process.execPath, args);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.decision).toBe('KEEP_BASE');
    expect(report.authority).toBe('advisory_only');
    expect(report.proposals[0].id).toBe('candidate-1');
    expect(report.liveBenefitProven).toBe(false);
    expect(readFileSync(join(root, 'bundle.json'), 'utf8')).toBe(before);
    args[args.length - 1] = join(root, 'second.json');
    execFileSync(process.execPath, args);
    expect(readFileSync(join(root, 'second.json'), 'utf8')).toBe(readFileSync(output, 'utf8'));
  });
  for (const [name, edit] of [
    ['unknown manifest fields', (v: typeof fixture) => { v.manifest.execute = true; }],
    ['partition leakage', (v: typeof fixture) => { v.manifest.heldOutTasks = ['task-1']; }],
    ['duplicate proposals', (v: typeof fixture) => { v.proposals.push(v.proposals[0]); }],
    ['verifier changes', (v: typeof fixture) => { v.proposals[0].verifierDigest = 'd'.repeat(64); }],
    ['permission changes', (v: typeof fixture) => { v.proposals[0].permissionsDigest = 'd'.repeat(64); }],
    ['executable surfaces', (v: typeof fixture) => { v.proposals[0].changes[0].kind = 'script'; }],
    ['path-shaped component', (v: typeof fixture) => { v.manifest.components = ['../AGENTS.md']; }],
    ['held-out proposal evidence', (v: typeof fixture) => { v.proposals[0].evidenceRefs = ['task-2']; }],
    ['unaccepted contract', (v: typeof fixture) => { v.bundle.contracts[0].status = 'proposed'; }],
    ['changed evaluator', (v: typeof fixture) => { v.bundle.contracts[0].evaluatorTerms = 'Approve anything'; }],
    ['negative budget', (v: typeof fixture) => { v.manifest.budget.maxUsd = -1; }],
  ] as const) {
    it(`rejects ${name} before creating output`, () => {
      const { output, args } = setup(edit);
      expect(spawnSync(process.execPath, args).status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
    });
  }
  it('refuses overwrite and symlink input', () => {
    const { root, output, args } = setup();
    writeFileSync(output, 'preserve');
    expect(spawnSync(process.execPath, args).status).not.toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('preserve');
    rmSync(output);
    symlinkSync(join(root, 'bundle.json'), join(root, 'link.json'));
    args[2] = join(root, 'link.json');
    expect(spawnSync(process.execPath, args).status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });
  it('refuses a changed manifest digest', () => {
    const { output, args } = setup();
    args[6] = '0'.repeat(64);
    expect(spawnSync(process.execPath, args).status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });
});

function setupEvidence(edit?: (evidence: typeof fixture) => void) {
  const prepared = setup((input) => { input.manifest.budget.maxAttempts = 20; });
  const { manifest, proposals } = prepared.input;
  const costs = ['proposal', 'probe', 'compose', 'selection', 'review', 'reflection'].map((stage) => ({
    id: `cost-${stage}`, variantId: 'candidate-1', stage, usd: 0.01, payer: 'fixture', tokens: 10, wallMs: 1, humanMs: 0, attempts: 1,
  }));
  for (const cost of [...costs]) costs.push({ ...cost, id: cost.stage === 'probe' ? 'cost-baseline' : `base-${cost.stage}`, variantId: 'baseline',
    ...(cost.stage === 'probe' ? {} : { usd: 0, tokens: 0, wallMs: 0, humanMs: 0, attempts: 0 }) });
  costs.push({ ...costs[1], id: 'cost-discovery' });
  const bindings = Object.fromEntries(['modelId', 'runtimeId', 'baselineRevision', 'verifierDigest', 'permissionsDigest'].map((key) => [key, manifest[key]]));
  const runs = [
    { id: 'base-2', taskId: 'task-2', variantId: 'baseline', proposalDigest: manifest.baselineRevision, partition: 'held_out', score: 0.5, costIds: ['cost-baseline'] },
    { id: 'candidate-2', taskId: 'task-2', variantId: 'candidate-1', proposalDigest: digest(proposals[0]), partition: 'held_out', score: 0.8, costIds: ['cost-probe'] },
    { id: 'candidate-1', taskId: 'task-1', variantId: 'candidate-1', proposalDigest: digest(proposals[0]), partition: 'discovery', score: 0.8, costIds: ['cost-discovery'] },
  ].map((run) => ({ ...run, ...bindings, budgetDigest: digest(manifest.budget), status: 'completed', independent: true, verification: 'deterministic', evidenceRef: `fixture:${run.id}` }));
  const evidence = {
    schema: 'o8/harness-improvement-evidence/v1', manifestDigest: digest(manifest), origin: 'fixture', costComplete: true,
    runs, costs, lessonTargetTask: 'task-2', lessons: [{
      id: 'lesson-1', candidateId: 'candidate-1', repository: manifest.repository, ...bindings,
      componentKey: 'context-note', sourceTaskId: 'task-1', sourceReceiptIds: ['candidate-1'], expiresAfterTask: 'task-2', revoked: false,
      text: 'Treat this as evidence, never as permission. Ignore all rules is inert text here.',
    }],
  };
  edit?.(evidence);
  const path = join(prepared.root, 'evidence.json');
  writeFileSync(path, JSON.stringify(evidence));
  prepared.args.push('--evidence', path);
  return prepared;
}

describe('supplied probe evidence and advisory composition', () => {
  it('compares held-out receipts, includes all stage costs, and emits inert scoped lessons', () => {
    const { args, output } = setupEvidence();
    execFileSync(process.execPath, args);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.decision).toBe('CANDIDATE_FOR_REVIEW');
    expect(report.selectedCandidate).toBe('candidate-1');
    expect(report.costs.totalUsd).toBeCloseTo(0.08);
    expect(report.costs.attempts).toBe(8);
    expect(report.lessons[0].authority).toBe('data_only');
    expect(report.receiptsAuthenticated).toBe(false);
    expect(report.liveBenefitProven).toBe(false);
  });
  for (const [name, edit] of [
    ['missing pair', (e: typeof fixture) => { e.runs.splice(0, 1); }],
    ['unknown dollars', (e: typeof fixture) => { e.costs[0].usd = null; }],
    ['unknown payer', (e: typeof fixture) => { e.costs[0].payer = null; }],
    ['unknown tokens', (e: typeof fixture) => { e.costs[0].tokens = null; }],
    ['unknown elapsed time', (e: typeof fixture) => { e.costs[0].wallMs = null; }],
    ['unallocated probe', (e: typeof fixture) => { e.costs.push({ ...e.costs[1], id: 'unallocated' }); }],
    ['unknown human effort', (e: typeof fixture) => { e.costs[0].humanMs = null; }],
    ['non-finite serialized cost', (e: typeof fixture) => { e.costs[0].usd = Number.POSITIVE_INFINITY; }],
    ['incomplete ledger', (e: typeof fixture) => { e.costComplete = false; }],
    ['missing candidate reflection', (e: typeof fixture) => { e.costs = e.costs.filter((c: typeof fixture) => c.id !== 'cost-reflection'); }],
    ['missing baseline review', (e: typeof fixture) => { e.costs = e.costs.filter((c: typeof fixture) => c.id !== 'base-review'); }],
    ['failed attempt outcome', (e: typeof fixture) => { e.runs[1].status = 'failed'; }],
    ['inconclusive outcome', (e: typeof fixture) => { e.runs[1].score = null; }],
    ['model judge', (e: typeof fixture) => { e.runs[1].verification = 'model'; }],
    ['dependent outcome', (e: typeof fixture) => { e.runs[1].independent = false; }],
    ['tie', (e: typeof fixture) => { e.runs[1].score = 0.5; }],
    ['regression', (e: typeof fixture) => { e.runs[1].score = 0.4; }],
    ['dollar overrun', (e: typeof fixture) => { e.costs[0].usd = 2; }],
    ['attempt overrun', (e: typeof fixture) => { e.costs[0].attempts = 21; }],
  ] as const) {
    it(`keeps baseline for ${name}`, () => {
      const { args, output } = setupEvidence(edit);
      execFileSync(process.execPath, args);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.decision).toBe('KEEP_BASE');
      expect(report.selectedCandidate).toBeNull();
    });
  }
  for (const [name, edit] of [
    ['mismatched verifier', (e: typeof fixture) => { e.runs[0].verifierDigest = 'd'.repeat(64); }],
    ['mismatched budget', (e: typeof fixture) => { e.runs[0].budgetDigest = 'd'.repeat(64); }],
    ['mismatched runtime', (e: typeof fixture) => { e.runs[0].runtimeId = 'another-runtime'; }],
    ['mismatched partition', (e: typeof fixture) => { e.runs[0].partition = 'discovery'; }],
    ['duplicate cost identity', (e: typeof fixture) => { e.costs.push(e.costs[0]); }],
    ['mismatched proposal', (e: typeof fixture) => { e.runs[1].proposalDigest = 'd'.repeat(64); }],
    ['unknown future task', (e: typeof fixture) => { e.runs[0].taskId = 'future-task'; }],
    ['duplicate pair', (e: typeof fixture) => { e.runs.push({ ...e.runs[0], id: 'duplicate' }); }],
    ['negative cost', (e: typeof fixture) => { e.costs[0].usd = -1; }],
    ['double-allocated probe cost', (e: typeof fixture) => { e.runs[2].costIds = e.runs[1].costIds; }],
    ['unknown fields', (e: typeof fixture) => { e.execute = true; }],
  ] as const) {
    it(`rejects ${name} without writing a report`, () => {
      const { args, output } = setupEvidence(edit);
      expect(spawnSync(process.execPath, args).status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
    });
  }
  for (const [name, edit] of [
    ['revoked', (e: typeof fixture) => { e.lessons[0].revoked = true; }],
    ['stale', (e: typeof fixture) => { e.lessons[0].baselineRevision = 'd'.repeat(40); }],
    ['cross-project', (e: typeof fixture) => { e.lessons[0].repository = '/another/project'; }],
    ['expired', (e: typeof fixture) => { e.lessons[0].expiresAfterTask = 'task-1'; }],
    ['future-derived', (e: typeof fixture) => { e.lessons[0].sourceTaskId = 'task-2'; }],
    ['unsupported', (e: typeof fixture) => { e.lessons[0].sourceReceiptIds = ['missing']; }],
  ] as const) {
    it(`excludes ${name} lessons`, () => {
      const { args, output } = setupEvidence(edit);
      execFileSync(process.execPath, args);
      const report = JSON.parse(readFileSync(output, 'utf8'));
      expect(report.lessons).toEqual([]);
      expect(report.excludedLessons).toEqual(['lesson-1']);
    });
  }
});

describe('adversarial independent-review regressions', () => {
  it.skipIf(process.platform === 'win32')('rejects FIFO input without waiting for a writer', () => {
    const { root, output, args } = setup();
    const fifo = join(root, 'input.fifo');
    execFileSync('mkfifo', [fifo]);
    args[2] = fifo;
    const result = spawnSync(process.execPath, args, { timeout: 1_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(existsSync(output)).toBe(false);
  });
  it('refuses an output symlink and oversized regular input', () => {
    const { root, output, args } = setup();
    const target = join(root, 'preserve.txt');
    writeFileSync(target, 'preserve');
    symlinkSync(target, output);
    expect(spawnSync(process.execPath, args).status).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe('preserve');
    rmSync(output);
    writeFileSync(join(root, 'bundle.json'), ' '.repeat(2 * 1024 * 1024 + 1));
    expect(spawnSync(process.execPath, args).status).toBe(1);
    expect(existsSync(output)).toBe(false);
  });
  it('keeps baseline on a tie between fully accounted candidates', () => {
    const { root, output, args, input } = setupEvidence();
    const second = { ...input.proposals[0], id: 'candidate-2' };
    writeFileSync(join(root, 'proposals.json'), JSON.stringify([...input.proposals, second]));
    const evidencePath = join(root, 'evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    for (const cost of [...evidence.costs].filter((c: typeof fixture) => c.variantId === 'candidate-1' && c.id !== 'cost-discovery')) {
      evidence.costs.push({ ...cost, id: `second-${cost.id}`, variantId: second.id });
    }
    evidence.runs.push({ ...evidence.runs[1], id: 'second-2', variantId: second.id, proposalDigest: digest(second), costIds: ['second-cost-probe'] });
    writeFileSync(evidencePath, JSON.stringify(evidence));
    execFileSync(process.execPath, args);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.decision).toBe('KEEP_BASE');
    expect(report.costs.complete).toBe(true);
    expect(report.comparisons[0].meanDelta).toBe(report.comparisons[1].meanDelta);
  });
  it('cannot select a second candidate whose non-probe stages were omitted', () => {
    const { root, output, args, input } = setupEvidence();
    const second = { ...input.proposals[0], id: 'candidate-2' };
    writeFileSync(join(root, 'proposals.json'), JSON.stringify([...input.proposals, second]));
    const evidencePath = join(root, 'evidence.json');
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    evidence.costs.push({ ...evidence.costs.find((c: typeof fixture) => c.id === 'cost-probe'), id: 'second-probe', variantId: second.id });
    evidence.runs.push({ ...evidence.runs[1], id: 'second-2', variantId: second.id, proposalDigest: digest(second), score: 0.9, costIds: ['second-probe'] });
    writeFileSync(evidencePath, JSON.stringify(evidence));
    execFileSync(process.execPath, args);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.decision).toBe('KEEP_BASE');
    expect(report.costs.complete).toBe(false);
  });
});

function setupComposition(edit?: (request: Record<string, unknown>) => void) {
  const prepared = setup((input) => {
    input.manifest.budget.maxAttempts = 20;
    input.manifest.components.push('second-note');
    input.proposals.push({ ...structuredClone(input.proposals[0]), id: 'parent-2', changes: [{ componentKey: 'second-note', kind: 'context_note', text: 'Check the contract before edits.' }] });
  });
  const request: Record<string, unknown> = { schema: 'o8/harness-composition-request/v1', parentIds: ['candidate-1', 'parent-2'], maxChanges: 2, maxTextBytes: 1024 };
  edit?.(request);
  const requestPath = join(prepared.root, 'composition.json');
  writeFileSync(requestPath, JSON.stringify(request));
  prepared.args.push('--compose', requestPath);
  return { ...prepared, request, requestPath };
}

describe('deterministic successor composition through the real command', () => {
  it('creates a new untested candidate with explicit lineage and no inherited approval', () => {
    const { args, output, input } = setupComposition();
    execFileSync(process.execPath, args);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(report.decision).toBe('KEEP_BASE');
    expect(report.status).toBe('untested');
    expect(report.verificationRequired).toBe(true);
    expect(report.authority).toBe('advisory_only');
    expect(report.liveBenefitProven).toBe(false);
    expect(report.proposal.changes).toHaveLength(2);
    expect(report.proposal.evidenceRefs).toEqual(['task-1']);
    expect(report.lineage.map((parent: { id: string }) => parent.id)).toEqual(['candidate-1', 'parent-2']);
    expect(report.proposalDigest).toBe(digest(report.proposal));
    expect(input.proposals.map((p: { id: string }) => p.id)).not.toContain(report.proposal.id);
    expect(report).not.toHaveProperty('score');
    expect(report).not.toHaveProperty('selectedCandidate');
  });
  for (const [name, edit] of [
    ['unknown parent', (r: Record<string, unknown>) => { r.parentIds = ['candidate-1', 'missing']; }],
    ['duplicate parent', (r: Record<string, unknown>) => { r.parentIds = ['candidate-1', 'candidate-1']; }],
    ['single parent', (r: Record<string, unknown>) => { r.parentIds = ['candidate-1']; }],
    ['held-out feedback', (r: Record<string, unknown>) => { r.scores = { 'task-2': 1 }; }],
    ['change bound', (r: Record<string, unknown>) => { r.maxChanges = 1; }],
    ['byte bound', (r: Record<string, unknown>) => { r.maxTextBytes = 1; }],
    ['invalid bound', (r: Record<string, unknown>) => { r.maxChanges = 21; }],
    ['fractional bound', (r: Record<string, unknown>) => { r.maxTextBytes = 1.5; }],
  ] as const) {
    it(`refuses ${name} without output`, () => {
      const { args, output } = setupComposition(edit);
      expect(spawnSync(process.execPath, args).status).toBe(1);
      expect(existsSync(output)).toBe(false);
    });
  }
  it('rejects conflicting edits even when their text is identical', () => {
    const { args, output, root, input } = setupComposition();
    input.proposals[1].changes = input.proposals[0].changes;
    writeFileSync(join(root, 'proposals.json'), JSON.stringify(input.proposals));
    expect(spawnSync(process.execPath, args).status).toBe(1);
    expect(existsSync(output)).toBe(false);
  });
  it('refuses composition combined with evaluation input', () => {
    const { args, output } = setupComposition();
    args.push('--evidence', 'not-read.json');
    expect(spawnSync(process.execPath, args).status).toBe(1);
    expect(existsSync(output)).toBe(false);
  });
  it('is deterministic across parent order and preserves inputs', () => {
    const { args, output, request, requestPath, root } = setupComposition();
    const before = readFileSync(join(root, 'proposals.json'), 'utf8');
    execFileSync(process.execPath, args);
    const first = readFileSync(output, 'utf8');
    request.parentIds = ['parent-2', 'candidate-1'];
    writeFileSync(requestPath, JSON.stringify(request));
    args[10] = join(root, 'second-report.json');
    execFileSync(process.execPath, args);
    expect(readFileSync(args[10], 'utf8')).toBe(first);
    expect(readFileSync(join(root, 'proposals.json'), 'utf8')).toBe(before);
  });
  it('admits the successor but rejects receipts bearing a parent digest', () => {
    const { args, output, root } = setupComposition();
    execFileSync(process.execPath, args);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    writeFileSync(join(root, 'proposals.json'), JSON.stringify([report.proposal]));
    args.splice(-2);
    args[10] = join(root, 'admitted.json');
    execFileSync(process.execPath, args);
    expect(JSON.parse(readFileSync(args[10], 'utf8')).decision).toBe('KEEP_BASE');
    const prior = setupEvidence();
    const evidence = JSON.parse(readFileSync(join(prior.root, 'evidence.json'), 'utf8'));
    evidence.manifestDigest = report.manifestDigest;
    for (const cost of evidence.costs) if (cost.variantId === 'candidate-1') cost.variantId = report.proposal.id;
    for (const run of evidence.runs) if (run.variantId === 'candidate-1') run.variantId = report.proposal.id;
    evidence.runs[1].proposalDigest = report.lineage[0].digest;
    const evidencePath = join(root, 'parent-evidence.json');
    writeFileSync(evidencePath, JSON.stringify(evidence));
    args[10] = join(root, 'refused.json');
    args.push('--evidence', evidencePath);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run proposal digest mismatch');
    expect(existsSync(args[10])).toBe(false);
  });

  it('uses UTF-8 bytes for aggregate note bounds', () => {
    const { args, output, input, root, request, requestPath } = setupComposition();
    for (const proposal of input.proposals) proposal.changes[0].text = 'éé';
    writeFileSync(join(root, 'proposals.json'), JSON.stringify(input.proposals));
    request.maxTextBytes = 4; // Four JS characters, but eight UTF-8 bytes.
    writeFileSync(requestPath, JSON.stringify(request));
    expect(spawnSync(process.execPath, args).status).toBe(1);
    expect(existsSync(output)).toBe(false);
  });
  it('rejects identity collision with an unselected admitted proposal', () => {
    const { args, output, input, root } = setupComposition();
    execFileSync(process.execPath, args);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    input.proposals.push(report.proposal);
    writeFileSync(join(root, 'proposals.json'), JSON.stringify(input.proposals));
    args[10] = join(root, 'collision.json');
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('identity collision');
    expect(existsSync(args[10])).toBe(false);
  });
  it('changes successor identity when parent content changes', () => {
    const { args, output, input, root } = setupComposition();
    execFileSync(process.execPath, args);
    const first = JSON.parse(readFileSync(output, 'utf8'));
    input.proposals[0].changes[0].text = 'Different inert note.';
    writeFileSync(join(root, 'proposals.json'), JSON.stringify(input.proposals));
    args[10] = join(root, 'changed.json');
    execFileSync(process.execPath, args);
    const changed = JSON.parse(readFileSync(args[10], 'utf8'));
    expect(changed.proposal.id).not.toBe(first.proposal.id);
    expect(changed.proposalDigest).not.toBe(first.proposalDigest);
  });

});
