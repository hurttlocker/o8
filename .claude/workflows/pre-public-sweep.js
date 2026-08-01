export const meta = {
  name: 'pre-public-sweep',
  description: 'Three-surface sweep before any repo goes public: tree, full history, GitHub surfaces',
  whenToUse: 'Before flipping any repo public, or auditing one that already is. Args: repo path + owner/name.',
  phases: [{ title: 'Sweep' }, { title: 'Synthesize' }],
}
const target = typeof args === 'string' ? args : JSON.stringify(args)
phase('Sweep')
const SURFACES = [
  'WORKING TREE of ' + target + ': grep tracked files for attribution shapes (possessive comparisons like SomeName's X vs ours, borrow/inspired/teardown/-style framing, social links, handles), secrets patterns, internal paths. Plain substrings, never \\b (git grep -E ignores it).',
  'FULL HISTORY of ' + target + ': commit messages across all refs, plus every doc blob that ever existed (git log --all --raw for *.md), plus paths ever deleted from tree (tree deletion is NOT history removal — enumerate services/, internal docs, anything de-publicized). Script loops to files, validate against one known-positive.',
  'GITHUB SURFACES of ' + target + ': all issue titles/bodies/comments, PR bodies, releases, repo metadata. Note per-hit: open/closed, comment count, cross-refs. Remember merged PRs are immutable and issue edit history is public.',
]
const found = await parallel(SURFACES.map((s) => () => agent('Read-only sweep. ' + s + ' Report a classified hit table (PERSON / RIVAL-ATTRIBUTION / CLOSED-SOURCE-RESIDUE / SECRET / UNSURE), judged, false-positives dropped. Change nothing.', { phase: 'Sweep' })))
phase('Synthesize')
return await agent('Merge these sweep reports into one inventory with the cheapest-correct action per hit (leave / transfer-private / delete / single history rewrite) and an explicit list of what is immutable. Reports: ' + found.filter(Boolean).join('\n---\n'), { phase: 'Synthesize' })
