export const meta = {
  name: 'adversarial-verify',
  description: 'Refuter panel: N independent skeptics attack a claim/feature before it closes',
  whenToUse: 'Before closing any feature, fix, or claim on the builder's word. Args: the claim + how to check it.',
  phases: [{ title: 'Refute' }, { title: 'Verdict' }],
}
const claim = typeof args === 'string' ? args : JSON.stringify(args)
const LENSES = ['correctness (drive the REAL entry point, not the helper)', 'reachability (does any live path actually hit this?)', 'regression (what did this break nearby?)']
phase('Refute')
const votes = await parallel(LENSES.map((lens) => () =>
  agent('Try to REFUTE this claim via the ' + lens + ' lens. Claim: ' + claim + '. Read the actual code/state; default to refuted=true if you cannot positively verify. Return JSON.', {
    phase: 'Refute',
    schema: { type: 'object', properties: { refuted: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['refuted', 'evidence'] },
  })))
phase('Verdict')
const real = votes.filter(Boolean)
return { survives: real.filter((v) => !v.refuted).length >= 2, votes: real }
