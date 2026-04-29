/**
 * Smoke test for #899 wave 2 — calls suggestProjects() against the live
 * registry + fingerprints. Acceptance: "o8" or "cortex-ide" Confident
 * grouping that contains BOTH cortex-ide and o8-site.
 */

import { suggestProjects } from '../src/lib/projects/suggest';

async function main() {
  console.log('[smoke] Running suggestProjects({ force: true })…');
  const result = await suggestProjects({ force: true });

  console.log('[smoke] Generated at:', new Date(result.generatedAt).toISOString());
  console.log('[smoke] Cached:', result.cached);
  console.log('[smoke] Suggestions:', result.suggestions.length);
  console.log('');

  for (const s of result.suggestions) {
    console.log('---');
    console.log('Name:', s.suggestedName);
    console.log('Confidence:', s.confidence);
    console.log('Repos:', s.repoIds.join(', '));
    console.log('Primary:', s.primaryRepoId ?? '(none)');
    console.log('Roles:', JSON.stringify(s.detectedRoles));
    console.log('Rationale:', s.rationale);
    console.log('Evidence (' + s.evidence.length + '):');
    for (const e of s.evidence) {
      console.log(`  - [${e.kind}] ${e.repoId}: ${e.snippet}`);
    }
  }

  // ── Daily-driver acceptance gate ──
  console.log('\n--- DAILY-DRIVER ACCEPTANCE GATE ---');
  const hasCortexIde = (s: { repoIds: string[] }) => s.repoIds.some((r) => r.includes('70954348'));
  const hasO8Site = (s: { repoIds: string[] }) => s.repoIds.some((r) => r.includes('a1c35bf5'));
  const target = result.suggestions.find((s) => hasCortexIde(s) && hasO8Site(s));

  if (!target) {
    console.error('FAIL: No grouping contains BOTH cortex-ide and o8-site');
    process.exit(1);
  }
  if (target.confidence !== 'confident') {
    console.error(`FAIL: Grouping found but confidence is "${target.confidence}", expected "confident"`);
    process.exit(1);
  }
  console.log(`PASS: Confident grouping "${target.suggestedName}" with both repos.`);
  console.log(`PASS: Roles detected:`, target.detectedRoles);
  console.log(`PASS: Evidence count:`, target.evidence.length);
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
