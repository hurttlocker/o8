#!/usr/bin/env node
// Dictation polish sweep — speed + accuracy across the candidate polish models.
// The polish route (src/app/api/dictation/polish/route.ts) loops flash-lite-latest
// → 2.5-flash-lite sequentially (a source of the "slow sometimes"). This measures
// each model alone (latency + cost) and shows raw→polished + a coverage ratio so we
// can eyeball accuracy (must NOT summarize / change meaning). Run: node scripts/founder-polish-sweep.mjs
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

const MODELS = [
  'google/gemini-flash-lite-latest', // polish primary
  'google/gemini-2.5-flash-lite',    // polish fallback
  'deepseek/deepseek-chat',          // speed/cost candidate
];

// Condensed from buildPolishSystemPrompt (polish-prompt.ts): correction + adaptive
// punctuation + the CRITICAL output-coverage guard (no summarizing).
const SYSTEM = [
  'You are a speech-to-text correction assistant for a developer using o8, an IDE for orchestrating AI coding agents.',
  'You receive an automatic transcript of the developer speaking. Return the cleaned-up final text — that and nothing else.',
  'CORRECTION: fix recognizer errors (homophones, missed/spliced words); preserve clearly-spoken wording; keep dev acronyms (API, TS, MCP, LLM, PR, CI) real; keep code identifier casing exact; wrap file paths/symbols in backticks when referred to as code.',
  'PUNCTUATION: commas for short pauses, periods for sentence ends, ? for questions, em dashes for asides, smart quotes for prose.',
  'OUTPUT COVERAGE (CRITICAL): output the FULL polished transcript. Do NOT summarize, omit clauses, or add commentary/preamble. Return only the corrected text.',
].join('\n');

const RAW = [
  { label: 'short-dev',
    text: 'um so i think we should like ship the founder thing tonight you know and then test it on stream tomorrow but the brain isnt wired yet so thats the gap we gotta fix first' },
  { label: 'code-refs',
    text: 'open the file src lib cortex qa composer dot t s and check the class a composer setting because thats where the tier selection happens and its not reading the entitlement flag at all' },
  { label: 'long-ramble',
    text: 'ok so the local model thing is a big deal right because right now everything is either bring your own key or our managed proxy theres no local option at all so we need to add a path where if someone has the power on their machine they can run the inference free and we also need a free model fallback for people who dont have a key or a local model so they still get some kind of help even if its slow you know what i mean' },
];

async function polish(model, text) {
  const t0 = performance.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, usage: { include: true }, max_tokens: 800, temperature: 0.1,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
      }),
    });
    const dt = performance.now() - t0;
    const j = await res.json();
    if (j.error) return { dt, err: j.error.message || JSON.stringify(j.error) };
    const out = (j.choices?.[0]?.message?.content || '').trim();
    return { dt, cost: j.usage?.cost, out };
  } catch (e) { return { dt: performance.now() - t0, err: String(e) }; }
}

const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;

(async () => {
  const agg = {};
  for (const r of RAW) {
    console.log(`\n========== ${r.label} (${words(r.text)} words raw) ==========`);
    console.log(`RAW: ${r.text}`);
    for (const m of MODELS) {
      const x = await polish(m, r.text);
      agg[m] ||= { lat: [], cost: 0, errs: 0 };
      if (x.err) { agg[m].errs++; console.log(`\n  [${m}] ERROR: ${x.err}`); continue; }
      agg[m].lat.push(x.dt); agg[m].cost += x.cost || 0;
      const cov = (words(x.out) / words(r.text)).toFixed(2); // ~1.0 = no summarizing; <<1 = dropped content
      console.log(`\n  [${m}]  ${(x.dt / 1000).toFixed(2)}s  $${(x.cost || 0).toFixed(5)}  coverage ${cov}x`);
      console.log(`  → ${x.out.replace(/\n/g, ' ⏎ ')}`);
    }
  }
  console.log('\n========== SUMMARY (avg over ' + RAW.length + ' transcripts) ==========');
  console.log('model'.padEnd(32), 'avg latency', ' total cost', ' errs');
  for (const m of MODELS) {
    const a = agg[m]; const avg = a.lat.length ? a.lat.reduce((x, y) => x + y, 0) / a.lat.length / 1000 : 0;
    console.log(m.padEnd(32), `${avg.toFixed(2)}s`.padEnd(11), `$${a.cost.toFixed(5)}`.padEnd(11), a.errs);
  }
})();
