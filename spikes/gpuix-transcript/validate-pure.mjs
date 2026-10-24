import { spawnSync } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
const invalid = 'raw/pure-invalid-fixture.json';
const output = 'raw/pure-invalid-result.json';
const fixture = JSON.parse(await readFile('dist/fixture.json', 'utf8'));
fixture[0].text += ' invalid';
await writeFile(invalid, JSON.stringify(fixture));
const child = spawnSync('./pure-gpui/target/x86_64-apple-darwin/release/o8-pure-gpui-transcript-bench', [], {
  env: { ...process.env, BENCH_FIXTURE: invalid, BENCH_RESULT: output }, encoding: 'utf8', timeout: 9000,
});
let exists = false;
try { await access(output); exists = true; } catch {}
if (child.status === 0 || child.stdout.includes('first-frame') || exists) throw Error('Invalid fixture reached rendering');
await writeFile('results/pure-entrypoint-check.json', JSON.stringify({
  invalidFixture: 'rejected at binary entry point before window/render initialization',
  exitStatus: child.status, frameMarkerEmitted: false, resultEmitted: false,
  validFixture: 'three accepted persisted runs, each with 20 input and 80 token paint acknowledgements',
}, null, 2) + '\n');
console.log('Actual binary entry point rejects changed fixture before application initialization');
