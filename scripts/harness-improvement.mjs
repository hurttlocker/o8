#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { analyzeEvidence } from './lib/harness-improvement-evidence.mjs';
import { canonicalJson, digest, validateAdmission } from './lib/harness-improvement.mjs';

const USAGE = 'node scripts/harness-improvement.mjs --bundle FILE --manifest FILE --manifest-sha256 SHA256 --proposals FILE [--evidence FILE] --out NEW_FILE';
const MAX_BYTES = 2 * 1024 * 1024;
function readJson(path) {
  const resolved = resolve(path);
  if (realpathSync(resolved) !== resolved) throw new Error('input symlinks are not supported');
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('input must be a regular file of at most 2 MiB');
    const raw = readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('input exceeds 2 MiB');
    return JSON.parse(raw);
  } finally { closeSync(fd); }
}
try {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(`${USAGE}\nOffline admission only; no execution, installation or promotion.\n`);
  } else {
    const required = ['--bundle', '--manifest', '--manifest-sha256', '--proposals', '--out'];
    const keys = [...required, '--evidence'];
    const args = new Map();
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index];
      if (!keys.includes(key) || args.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(USAGE);
      args.set(key, argv[index + 1]);
    }
    if (required.some((key) => !args.has(key))) throw new Error(USAGE);
    const manifest = readJson(args.get('--manifest'));
    const proposals = readJson(args.get('--proposals'));
    const admission = validateAdmission(readJson(args.get('--bundle')), manifest, proposals, args.get('--manifest-sha256'));
    const report = args.has('--evidence')
      ? analyzeEvidence(admission, manifest, proposals, readJson(args.get('--evidence'))) : admission;
    const result = { ...report, reportDigest: digest(report) };
    const output = resolve(args.get('--out'));
    if (realpathSync(dirname(output)) !== dirname(output)) throw new Error('output directory symlinks are not supported');
    // Exclusive creation prevents overwriting inputs, an earlier report or a symlink.
    writeFileSync(output, `${canonicalJson(result)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${result.decision}: advisory report written\n`);
  }
} catch (error) {
  process.stderr.write(`Harness improvement refused: ${error instanceof Error ? error.message : 'invalid input'}\n`);
  process.exitCode = 1;
}
