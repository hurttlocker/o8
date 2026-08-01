export const meta = {
  name: 'issue-evidence-close',
  description: 'Sweep open issues for ones already resolved in code; close only with commit-level evidence',
  whenToUse: 'Backlog hygiene. Finds issues the codebase already fixed; every close cites the proving code/commit.',
  phases: [{ title: 'Scan' }, { title: 'Prove' }],
}
phase('Scan')
const candidates = await agent('List open issues (gh issue list --limit 200 --json number,title,body) and pick up to 12 that the CURRENT code plausibly already resolves. Return JSON array of {number, title, why}.', {
  phase: 'Scan',
  schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { number: { type: 'number' }, title: { type: 'string' }, why: { type: 'string' } }, required: ['number', 'title', 'why'] } } }, required: ['items'] },
})
phase('Prove')
const proven = await parallel(candidates.items.map((c) => () =>
  agent('Issue #' + c.number + ' (' + c.title + '): ' + c.why + '. VERIFY against the real code — find the exact file/commit that resolves it, or refute. Do NOT close anything. Return JSON.', {
    phase: 'Prove',
    schema: { type: 'object', properties: { number: { type: 'number' }, resolved: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['number', 'resolved', 'evidence'] },
  })))
return { closable: proven.filter(Boolean).filter((p) => p.resolved) }
