/** Debug one brain question end-to-end with retrieval diagnostics. */
import { classifyQuestion } from '../src/lib/cortex/qa/classifier';
import { retrieveAll, unionMerge } from '../src/lib/cortex/qa/retrieve';

async function main() {
  const question = process.argv[2] ?? 'What is the maximum file line count allowed before decomposing a file in this repo?';
  const repoPath = process.cwd();
  const c = await classifyQuestion(question);
  console.log('class:', c.class, '| variants:', JSON.stringify(c.bm25Variants));
  const results = await retrieveAll({ question, repoPath, projectId: undefined, bm25Variants: c.bm25Variants, questionClass: c.class });
  for (const r of results) console.log(`retriever=${r.retriever} rows=${r.rows.length} durationMs=${r.durationMs}`);
  const top = unionMerge(results, { questionClass: c.class });
  console.log('topRows:', top.length);
  for (const row of top.slice(0, 5)) console.log('  -', row.citation.kind, row.citation.rowId, JSON.stringify((row.citation.excerpt ?? '').slice(0, 90)));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
