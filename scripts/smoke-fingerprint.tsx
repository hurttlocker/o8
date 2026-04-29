// #899 — Smoke test for the Stage 1 fingerprint extractor.
//
// Runs against the registered cortex-ide + o8-site repos plus a hypothetical
// empty path. Verifies size cap, deterministic hash, cache invalidation,
// and the privacy guarantees (no source code, no .env values).
//
// Run from the worktree root:
//   O8_DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-fingerprint.tsx

import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';

import { computeFingerprint, __TEST } from '@/lib/projects/fingerprint';
import {
  getOrComputeFingerprint,
  getOrComputeFingerprintForPath,
  getFingerprintCacheDir,
} from '@/lib/projects/fingerprint-cache';
import { listRepos } from '@/lib/repos/registry';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, debug?: unknown) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${debug !== undefined ? ` :: ${JSON.stringify(debug)}` : ''}`);
  }
}

function byteLen(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf-8');
}

async function main() {
  console.log('--- 1. cortex-ide (large repo) ---');
  const repos = await listRepos();
  const cortex = repos.find((r) => r.name === 'cortex-ide');
  if (!cortex) throw new Error('cortex-ide not in registry — run o8 once to populate ~/.o8/repos.json.');

  const fp1 = await getOrComputeFingerprint(cortex.id);
  console.log(JSON.stringify(fp1, null, 2));
  console.log(`  size: ${byteLen(fp1)} bytes`);

  check('cortex-ide ≤ 2KB', byteLen(fp1) <= __TEST.MAX_BYTES, byteLen(fp1));
  check('cortex-ide manifest=package.json', fp1.manifest.type === 'package.json', fp1.manifest.type);
  check('cortex-ide hash is sha256-shaped', /^[a-f0-9]{64}$/.test(fp1.hash), fp1.hash);
  check('cortex-ide has nextConfig hint', fp1.deployHints.nextConfig !== undefined);
  // envExampleKeys may be evicted by the size cap for big repos — that's the
  // documented behaviour. We only assert that IF it's present, it's KEYS only.
  const envCaptured = Array.isArray(fp1.deployHints.envExampleKeys);
  console.log(`  (envExampleKeys ${envCaptured ? 'present' : 'evicted by size cap'})`);
  const envOk = (fp1.deployHints.envExampleKeys ?? []).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  check('envExampleKeys (if present) are KEYS only', envOk);

  // Privacy: no version values inside dep arrays. Versions look like "1.2.3"
  // or "^1.0.0" — bare names never contain digits-only or caret/tilde prefixes.
  const depOk = (fp1.manifest.dependencies ?? []).every((n) => !/^[~^]?\d/.test(n));
  check('dep entries are NAMES only (no versions)', depOk);

  // Privacy: serialized fingerprint must not contain the literal contents of
  // any .env value. Spot-check by ensuring no '=' immediately follows a
  // candidate key (would indicate "KEY=val" leaked through).
  const serialized = JSON.stringify(fp1);
  check('no KEY=value patterns in fingerprint', !/[A-Z_]+=[^,"\s}]+/.test(serialized));

  console.log('\n--- 2. o8-site (small repo) ---');
  const o8 = repos.find((r) => r.name === 'o8-site');
  if (o8) {
    const fp2 = await getOrComputeFingerprint(o8.id);
    console.log(JSON.stringify(fp2, null, 2));
    console.log(`  size: ${byteLen(fp2)} bytes`);
    check('o8-site ≤ 2KB', byteLen(fp2) <= __TEST.MAX_BYTES, byteLen(fp2));
  } else {
    console.log('  (skipped — o8-site not registered)');
  }

  console.log('\n--- 3. empty repo path ---');
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-empty-'));
  try {
    const fp3 = computeFingerprint('empty-repo-id', emptyDir);
    console.log(JSON.stringify(fp3, null, 2));
    check('empty repo skeleton has manifest=unknown', fp3.manifest.type === 'unknown');
    check('empty repo skeleton has empty deployHints', Object.keys(fp3.deployHints).length === 0);
    check('empty repo skeleton has empty topLevelFolders', fp3.topLevelFolders.length === 0);
    check('empty repo skeleton ≤ 2KB', byteLen(fp3) <= __TEST.MAX_BYTES);
    check('empty repo skeleton hash is sha256-shaped', /^[a-f0-9]{64}$/.test(fp3.hash));
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  console.log('\n--- 4. nonexistent repo path ---');
  const fp4 = computeFingerprint('ghost-repo', '/this/path/does/not/exist/anywhere');
  check('nonexistent repo returns valid skeleton', fp4.manifest.type === 'unknown' && fp4.topLevelFolders.length === 0);

  console.log('\n--- 5. determinism + cache invalidation ---');
  // Build a tiny throwaway repo, fingerprint twice — hash should match.
  const fakeRepo = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-fake-'));
  try {
    writeFileSync(
      path.join(fakeRepo, 'package.json'),
      JSON.stringify({
        name: 'fake-pkg',
        description: 'tiny',
        dependencies: { lodash: '^4.0.0', react: '^18.0.0' },
      }),
    );
    writeFileSync(path.join(fakeRepo, 'README.md'), '# Fake\n\nA test repo.\n');
    writeFileSync(path.join(fakeRepo, '.env.example'), 'API_KEY=do_not_leak\nDATABASE_URL=postgres://lol\n');
    mkdirSync(path.join(fakeRepo, 'src'));
    mkdirSync(path.join(fakeRepo, 'docs'));

    const a = computeFingerprint('fake-repo', fakeRepo);
    const b = computeFingerprint('fake-repo', fakeRepo);
    check('determinism: hash matches across two fresh runs', a.hash === b.hash, { a: a.hash, b: b.hash });
    check('fake repo .env values not leaked', !JSON.stringify(a).includes('do_not_leak') && !JSON.stringify(a).includes('postgres://lol'));
    const envKeys = a.deployHints.envExampleKeys ?? [];
    check('fake repo .env keys ARE captured', envKeys.includes('API_KEY') && envKeys.includes('DATABASE_URL'));

    // Now mutate the README → hash MUST change.
    writeFileSync(path.join(fakeRepo, 'README.md'), '# Fake\n\nMUTATED.\n');
    const c = computeFingerprint('fake-repo', fakeRepo);
    check('cache invalidation: README change → new hash', a.hash !== c.hash, { a: a.hash, c: c.hash });

    // Cache round-trip via getOrComputeFingerprintForPath.
    const tmpData = mkdtempSync(path.join(os.tmpdir(), 'fingerprint-data-'));
    process.env.O8_DATA_DIR = tmpData;
    try {
      const d1 = getOrComputeFingerprintForPath('fake-repo', fakeRepo);
      const d2 = getOrComputeFingerprintForPath('fake-repo', fakeRepo);
      check('cache: two reads return same hash', d1.hash === d2.hash);
      check('cache: cache file written', readdirSync(getFingerprintCacheDir()).length > 0);
    } finally {
      rmSync(tmpData, { recursive: true, force: true });
      delete process.env.O8_DATA_DIR;
    }
  } finally {
    rmSync(fakeRepo, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('smoke threw:', err);
  process.exit(1);
});
