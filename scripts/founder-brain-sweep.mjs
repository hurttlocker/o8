#!/usr/bin/env node
// Founder managed-inference sweep — Brain compose tier comparison.
// Measures speed / cost / answer-quality across the candidate models the Brain
// could route founders to, so we can pick the best fast-tier (and tune later for
// the $19 subscription tier). Standalone OpenRouter calls (Q's key) with a
// Brain-style compose prompt — isolates the MODEL variable. Run: node scripts/founder-brain-sweep.mjs
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

// Candidate fast-tier models (skip deprecated grok-4.1-fast). sonnet = quality benchmark.
const MODELS = [
  'google/gemini-2.5-flash-lite',
  'x-ai/grok-4.3',
  'deepseek/deepseek-chat',
  'anthropic/claude-sonnet-5',
];

// Representative o8 repo Q&A (context mimics retrieved chunks; answers are checkable).
const CASES = [
  { q: 'What is o8 in one sentence?',
    ctx: 'o8 (formerly Cortex IDE) is a Next.js 16 + Tauri v2 desktop app — the governance layer for autonomous engineering teams: approvals, audit, organizational memory, and mobile operator control across any AI provider. Shipping pattern: Claude Code orchestrates, Codex works.' },
  { q: 'What are the five layers of the merge-failure escalation chain?',
    ctx: 'When a packet post-rebase typecheck fails during approve_and_merge, recovery escalates through five layers: (1) auto-rerun cap 1, (2) escalate to orchestrator (awaiting_orchestrator), (3) steer the warm session, (4) fresh redispatch, (5) human approval card. Cost ceiling is 1 extra Codex turn before any human/orchestrator attention.' },
  { q: 'What files change to add a 5th runtime adapter?',
    ctx: 'Adding a runtime is a 6-file patch: src/lib/<rt>/owned.ts (adapter + owned-session store), src/lib/runtimes/<rt>.ts (AgentRuntime impl), the cost-parser, add a literal to the OrchestratorRuntime union, add a row to the ORCHESTRATOR_RUNTIMES map, and register in src/lib/runtimes/index.ts.' },
];

const SYSTEM = "You are o8's engineering brain. Answer the question concisely and accurately using ONLY the provided context. 2-4 sentences, no preamble.";

async function call(model, q, ctx) {
  const t0 = performance.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, usage: { include: true }, max_tokens: 400, temperature: 0.2,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Context:\n${ctx}\n\nQuestion: ${q}` }],
      }),
    });
    const dt = performance.now() - t0;
    const j = await res.json();
    if (j.error) return { dt, err: j.error.message || JSON.stringify(j.error) };
    const u = j.usage || {};
    const answer = (j.choices?.[0]?.message?.content || '').trim();
    return { dt, cost: u.cost, ptok: u.prompt_tokens, ctok: u.completion_tokens, answer };
  } catch (e) { return { dt: performance.now() - t0, err: String(e) }; }
}

(async () => {
  const agg = {};
  for (const c of CASES) {
    console.log(`\n=== Q: ${c.q} ===`);
    for (const m of MODELS) {
      const r = await call(m, c.q, c.ctx);
      agg[m] ||= { lat: [], cost: 0, errs: 0 };
      if (r.err) { agg[m].errs++; console.log(`  ${m.padEnd(32)} ERROR: ${r.err}`); continue; }
      agg[m].lat.push(r.dt); agg[m].cost += r.cost || 0;
      const costStr = r.cost != null ? `$${r.cost.toFixed(5)}` : `${r.ptok}+${r.ctok}tok`;
      console.log(`  ${m.padEnd(32)} ${(r.dt / 1000).toFixed(2)}s  ${costStr.padEnd(11)} ${r.answer.replace(/\s+/g, ' ').slice(0, 110)}…`);
    }
  }
  console.log('\n========== SUMMARY (avg over ' + CASES.length + ' questions) ==========');
  console.log('model'.padEnd(32), 'avg latency', ' total cost', ' errs');
  for (const m of MODELS) {
    const a = agg[m]; const avg = a.lat.length ? a.lat.reduce((x, y) => x + y, 0) / a.lat.length / 1000 : 0;
    console.log(m.padEnd(32), `${avg.toFixed(2)}s`.padEnd(11), `$${a.cost.toFixed(5)}`.padEnd(11), a.errs);
  }
})();
