#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A report wrapper around the existing integration harness, not another runner.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFile = 'tests/handoff-packet-real-path.test.ts';
const sourceFiles = [
  'src/app/api/orchestrator/handoff/route.ts',
  'src/lib/orchestrator/handoff-packet.ts',
  'src/lib/lane/lane-diff-facts.ts',
  testFile,
  'scripts/handoff-evidence-rehearsal.mjs',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const sourceIdentity = () => ({
  head: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain=v1').length > 0,
  entrypointSha256: Object.fromEntries(sourceFiles.map((file) => [file, hash(readFileSync(join(root, file)))])),
});

if (Number(process.versions.node.split('.')[0]) !== 22 || process.argv.length > 3) {
  console.error('Use Node.js 22: node scripts/handoff-evidence-rehearsal.mjs [new-output-directory]');
  process.exit(1);
}
// A fresh output directory and exclusive writes prevent old receipts passing a new run.
const output = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'o8-handoff-evidence-'));
if (process.argv[2]) mkdirSync(output);
let fixtureRoot = null;
let dependencyRoot = null;
let source = null;
let reportPublished = false;
let summary = null;
const sanitize = (value) => [
  [dependencyRoot, '<dependencies>'], [root, '<checkout>'],
  [fixtureRoot, '<fixture-root>'], [output, '<evidence-output>'],
].reduce((text, [path, label]) => path ? text.replaceAll(path, label) : text, value);
const pendingPath = join(output, 'fixture-receipt.pending.json');
const logPath = join(output, 'verification.log');
const testReportPath = join(output, 'vitest.json');
const writeJson = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const startedAt = new Date().toISOString();
const scrubTestReport = () => {
  if (existsSync(testReportPath)) writeFileSync(testReportPath, sanitize(readFileSync(testReportPath, 'utf8')));
};
const cleanupFixtures = () => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
};
const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'config/vitest/vitest.integration.config.ts', testFile];
try {
  dependencyRoot = realpathSync(join(root, 'node_modules'));
  source = sourceIdentity();
  fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-handoff-rehearsal-fixtures-'));
  const env = {
    ...process.env,
    CORTEX_IDE_DATA_DIR: fixtureRoot,
    O8_TEST_FIXTURE_SWEEP_PARENT: fixtureRoot,
    O8_HANDOFF_REHEARSAL_RECEIPT: pendingPath,
    O8_TEST_GATE_REPORT_PATH: testReportPath,
  };
  for (const key of ['O8_DATA_DIR', 'O8_OPERATOR_DATA_DIR', 'O8_TEST_DATA_DIR_PINNED', 'O8_TEST_RUN_DATA_ROOT']) delete env[key];
  const run = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Keep even the test log portable: private source and temporary roots are redacted.
  writeFileSync(logPath, sanitize(`${run.stdout ?? ''}${run.stderr ?? ''}`), { flag: 'wx' });
  if (run.error || run.status !== 0) throw new Error(`Integration harness failed (exit ${run.status}, signal ${run.signal ?? 'none'}).`);
  const tests = JSON.parse(readFileSync(testReportPath, 'utf8'));
  const assertions = tests.testResults.flatMap((result) => result.assertionResults);
  const companion = assertions.filter((test) => test.title === 'exports a diagnostic-only evidence companion rehearsal');
  if (!tests.success || tests.numFailedTests !== 0 || companion.length !== 1 || companion[0].status !== 'passed') {
    throw new Error('The integration report did not confirm the companion test passed exactly once.');
  }
  const receipt = JSON.parse(readFileSync(pendingPath, 'utf8'));
  if (receipt.schema !== 'o8/handoff-evidence-rehearsal/v1' || receipt.result !== 'passed'
    || receipt.observations.length !== 4 || receipt.observations.some((item) => item.result !== 'passed')) {
    throw new Error('The fixture receipt is incomplete.');
  }
  if (JSON.stringify(sourceIdentity()) !== JSON.stringify(source)) throw new Error('Source changed while the rehearsal ran.');
  writeJson('receipts.pending.json', {
    ...receipt, source,
    execution: { startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: process.platform,
      command: 'node scripts/handoff-evidence-rehearsal.mjs', harness: ['node', ...args],
      tests: { passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests } },
  });
  const lines = [
    'Handoff workspace evidence rehearsal: PASSED',
    '',
    'A and B are fixture code, not dispatched agents. This run uses real Git and the existing handoff capture, persistence and inspection path.',
    ...receipt.observations.map((item) => `PASS ${item.scenario}: ${item.diagnostic.status} (${item.diagnostic.reason})`),
    'PASS Original persisted handoff, placeholder intent and normal Git index preserved.',
    'PASS Re-observation saved a new handoff; the original remained stale.',
    '',
    'Placeholder goal: Make this respond faster. Keep the layout and existing behavior. Do not deploy.',
    'No baseline or performance target was chosen; this narrative is not an admitted authored R1.',
    ...receipt.notRun.map((item) => `NOT RUN: ${item}`),
    'Fresh/stale/unavailable are diagnostics. This run grants no ACT authority and proves no live receiver enforcement.',
    '',
    `Integration file: ${tests.numPassedTests} passed, ${tests.numFailedTests} failed, ${tests.numPendingTests} skipped.`,
    `Source commit: ${source.head}${source.dirty ? ' (local changes; exact entrypoint hashes in receipts.json)' : ''}`,
    'Scope: Git-normalized, non-ignored workspace evidence at observation time; no atomic check-and-ACT guarantee.',
  ];
  writeFileSync(join(output, 'report.pending.txt'), `${lines.join('\n')}\n`, { flag: 'wx' });
  scrubTestReport();
  rmSync(pendingPath);
  cleanupFixtures();
  if (existsSync(join(output, 'report.txt')) || existsSync(join(output, 'receipts.json'))) {
    throw new Error('A final evidence destination already exists.');
  }
  renameSync(join(output, 'report.pending.txt'), join(output, 'report.txt'));
  reportPublished = true;
  summary = `${lines.slice(0, 8).join('\n')}\n\nEvidence: ${output}`;
  // Atomic publication is the final fallible step. No success receipt exists before it.
  renameSync(join(output, 'receipts.pending.json'), join(output, 'receipts.json'));
} catch (error) {
  process.exitCode = 1;
  summary = null;
  const errors = [sanitize(error instanceof Error ? error.message : String(error))];
  for (const cleanup of [scrubTestReport, cleanupFixtures,
    () => { if (reportPublished) rmSync(join(output, 'report.txt')); }]) {
    try { cleanup(); } catch (cleanupError) { errors.push(sanitize(String(cleanupError))); }
  }
  try {
    writeJson('run-failure.json', { result: 'failed', startedAt, source, errors,
      evidence: 'Every pending file is provisional. Only receipts.json marks an accepted run.' });
  } catch (reportError) { errors.push(sanitize(String(reportError))); }
  console.error(`Rehearsal FAILED: ${errors.join('; ')}\nEvidence: ${output}`);
}
if (summary) console.log(summary);
