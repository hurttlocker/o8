import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--project')) {
  console.error('Usage: node scripts/typecheck-parity.mjs [--project tsconfig.json]');
  process.exit(1);
}

// No type generation or reduced file list: the default is exactly the root
// project used by tsc --noEmit. --project also permits small negative fixtures.
const checkers = [
  ['tsc', 'typescript', 'tsc'],
  ['native', 'typescript-native', 'tsc'],
  ['tsrs', 'tsrs', 'tsrs'],
];
const results = [];
for (const [name, packageName, binary] of checkers) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [
    join(dirname(require.resolve(`${packageName}/package.json`)), 'bin', binary),
    '--noEmit', '--pretty', 'false', ...args,
  ], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  if (result.error || result.signal || result.status === null) {
    console.error(`${name}: checker failed to run`, result.error?.message ?? result.signal);
    process.exit(1);
  }

  const output = `${result.stdout}${result.stderr}`.replaceAll('\r\n', '\n').trim();
  // Compare entire diagnostics, including location, code and continuation text.
  // Only order, indentation and path separators are presentation differences.
  const diagnostics = output ? output.split(/\n(?=\S)/).map((block) => (
    block.replace(/^.*?(?=\(\d+,\d+\): error TS\d+: )/, (file) => file.replaceAll('\\', '/'))
      .split('\n').map((line) => line.trim()).join('\n')
  )) : [];
  const validOutput = diagnostics.every((line) => (
    /^(?:.*\(\d+,\d+\): )?error TS\d+: /.test(line)
  ));
  const set = [...new Set(diagnostics)].sort();
  console.log(`${name}: ${set.length} diagnostics, exit ${result.status}, ${((performance.now() - start) / 1000).toFixed(2)} s`);
  if (!validOutput) {
    console.error(`${name}: unrecognized checker output\n${output}`);
    process.exit(1);
  }
  results.push({ name, set, status: result.status });
}

const baseline = results[0];
const matches = results.every(({ set }) => JSON.stringify(set) === JSON.stringify(baseline.set));
if (!matches) {
  console.error('FAIL: diagnostic sets differ.');
  for (const { name, set } of results.slice(1)) {
    for (const diagnostic of baseline.set.filter((entry) => !set.includes(entry))) {
      console.error(`${name} missing: ${diagnostic}`);
    }
    for (const diagnostic of set.filter((entry) => !baseline.set.includes(entry))) {
      console.error(`${name} extra: ${diagnostic}`);
    }
  }
} else {
  console.log(`PASS: diagnostic sets match (${baseline.set.length} diagnostics).`);
}
// Matching failures are still failures; different compiler exit conventions do
// not themselves constitute a diagnostic mismatch.
process.exit(matches && results.every(({ status, set }) => status === 0 && set.length === 0) ? 0 : 1);
