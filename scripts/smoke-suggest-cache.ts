/**
 * Cache hit check for #899 wave 2.
 *  - Call once with force:false → should hit the cache written by the prior
 *    smoke run → cached:true, no LLM call.
 *
 * If you also want to exercise force:true, run smoke-suggest.ts again.
 */

import { suggestProjects } from '../src/lib/projects/suggest';

async function main() {
  console.log('[cache-smoke] suggestProjects({ force: false }) — should be a pure cache hit');
  const r = await suggestProjects({ force: false });
  console.log(`  cached=${r.cached}`);
  console.log(`  suggestions=${r.suggestions.length}`);
  console.log(`  first=${r.suggestions[0]?.suggestedName ?? '(none)'}`);
  if (!r.cached) {
    console.error('FAIL: expected cached:true (the prior force run wrote a cache entry)');
    process.exit(1);
  }
  console.log('PASS: cache hit returned without an LLM call.');
}

main().catch((err) => {
  console.error('[cache-smoke] FAILED:', err);
  process.exit(1);
});
