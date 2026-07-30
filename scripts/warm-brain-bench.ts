/**
 * Warm-CLI Brain latency A/B — the missing data point (2026-06-22).
 *
 * Measures, head-to-head on the SAME representative Brain compose payload:
 *   - flash-lite (OpenRouter HTTP)  — today's founder fast tier
 *   - warm Haiku  (warm REPL pool, subscription-billed) — cold spawn vs warm hit
 *   - warm Sonnet (warm REPL pool, subscription-billed) — cold spawn vs warm hit
 *
 * Purpose: settle whether a warm Claude CLI tier is "fast enough" to be the free
 * default Brain, and whether the persistent-session port is worth building. The
 * investigation's verdict was "single-digit seconds, not 0.5s" — this turns that
 * estimate into a number.
 *
 * Run (server-only poison pill + Q's OpenRouter key already in env):
 *   NODE_OPTIONS='--conditions=react-server' npx tsx scripts/warm-brain-bench.ts
 *
 * Each warm sample is measured AFTER a fresh prewarm + settle, so it is a true
 * warm hit (the proc is already idle when askClaudeWarm takes it).
 */
import { performance } from 'node:perf_hooks';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { askClaudeWarm, prewarmClaudeRepl, resetWarmReplPool } from '@/lib/claude-code/warm-repl-pool';

const CLAUDE_BIN = process.env.O8_CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude');
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5';
const FLASH = 'google/gemini-2.5-flash-lite';
const OR_KEY = process.env.OPENROUTER_API_KEY;

const SYSTEM =
  "You are o8's engineering brain. Answer the question concisely and accurately using ONLY the provided context. 2-4 sentences, no preamble.";

// Representative payload: ~10 retrieved chunks (mimics a real multi-row compose,
// not the trivially-small single-paragraph case). This is what makes the warm-hit
// number honest — generation time scales with payload, which is the real wall.
const ROWS = [
  'o8 (formerly Cortex IDE) is a Next.js 16 + Tauri v2 desktop app — the governance layer for autonomous engineering teams: approvals, audit, organizational memory, mobile operator control across any AI provider.',
  'Shipping runtime pattern v1: Claude Code orchestrates (interactive REPL spawn, subscription-billed, NOT claude -p which was retired in #1066), Codex GPT-5.5 xhigh is the worker in isolated worktrees.',
  'The merge-failure escalation chain has five layers: (1) auto-rerun cap 1, (2) escalate to orchestrator awaiting_orchestrator, (3) steer the warm session, (4) fresh redispatch, (5) human approval card. Cost ceiling: 1 extra Codex turn.',
  'Adding a 5th runtime adapter is a 6-file patch: owned.ts, runtimes/<rt>.ts, the cost-parser, a literal in the OrchestratorRuntime union, a row in ORCHESTRATOR_RUNTIMES, and registration in runtimes/index.ts.',
  'The WebSocket server (port 3002) multiplexes mobile real-time data. LOSSY channels (chat deltas, terminal) drop under backpressure; DURABLE channels (inbox, review, lane-lifecycle) queue with a polling fallback.',
  'Cortex v2 is the in-process org-memory subsystem: directives (operator rules) + a session-outcomes ledger. The auto-directive proposer surfaces candidates when a fix-pattern recurs >=3x in 14 days.',
  'The Engineering Brain Q&A pipeline classifies (Class A factual / Class B narrative), runs 4 parallel retrievers with RRF unionMerge, then composes, streaming tokens via SSE with a sources event first.',
  'Database is SQLite via better-sqlite3 + Drizzle in ~/.o8, WAL mode, FK constraints on, schema auto-migrates on first getDb() call with markers at ~/.o8/.db-migrated-v*.',
  'The middleware gates dangerous API prefixes on loopback origin + a bearer ws-token; the bundled server stamps the real TCP peer into x-o8-client-addr so a non-loopback socket can only pass with the token.',
  'Theme system is two-axis: palette (light/dark) controls color tokens, surface (glass/solid) controls whether chrome bleeds the macOS vibrancy backdrop. The workspace center is always solid, never glass.',
];
const CTX = ROWS.map((r, i) => `[${i + 1}] ${r}`).join('\n');

const CASES = [
  'What is the o8 shipping runtime pattern in one sentence?',
  'What are the five layers of the merge-failure escalation chain?',
  'How does the middleware decide whether a request can touch agent state?',
];

function buildPrompt(q: string): string {
  return `${SYSTEM}\n\nContext:\n${CTX}\n\nQuestion: ${q}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function flashCall(prompt: string): Promise<{ dt: number; text: string; err?: string }> {
  const t0 = performance.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: FLASH,
        max_tokens: 400,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const dt = performance.now() - t0;
    const j = (await res.json()) as { error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
    if (j.error) return { dt, text: '', err: j.error.message || 'error' };
    return { dt, text: (j.choices?.[0]?.message?.content || '').trim() };
  } catch (e) {
    return { dt: performance.now() - t0, text: '', err: String(e) };
  }
}

async function warmCall(model: string, prompt: string): Promise<{ dt: number; text: string; err?: string }> {
  const t0 = performance.now();
  try {
    const text = await askClaudeWarm(prompt, { binary: CLAUDE_BIN, model, timeoutMs: 120_000 });
    return { dt: performance.now() - t0, text: text.trim() };
  } catch (e) {
    return { dt: performance.now() - t0, text: '', err: String(e) };
  }
}

async function measureWarmTier(label: string, model: string): Promise<void> {
  console.log(`\n──── ${label} (${model}) ────`);

  // COLD: no prewarm — first call pays the full bootstrap. One sample.
  resetWarmReplPool();
  const cold = await warmCall(model, buildPrompt(CASES[0]));
  if (cold.err) {
    console.log(`  COLD   ERROR: ${cold.err.slice(0, 160)}`);
    return; // if cold errors (no sub / binary), warm will too — bail this tier
  }
  console.log(`  COLD   ${(cold.dt / 1000).toFixed(2)}s   ${cold.text.replace(/\s+/g, ' ').slice(0, 90)}…`);

  // WARM: fresh prewarm + settle before EACH sample so every measured call is a
  // true warm hit (proc already idle when askClaudeWarm takes it).
  const warmLat: number[] = [];
  for (let i = 0; i < CASES.length; i += 1) {
    resetWarmReplPool();
    prewarmClaudeRepl(CLAUDE_BIN, model);
    await sleep(13_000); // let the warm proc boot to idle (bootstrap ~6-9s + margin)
    const r = await warmCall(model, buildPrompt(CASES[i]));
    if (r.err) {
      console.log(`  WARM#${i + 1} ERROR: ${r.err.slice(0, 120)}`);
      continue;
    }
    warmLat.push(r.dt);
    console.log(`  WARM#${i + 1} ${(r.dt / 1000).toFixed(2)}s   ${r.text.replace(/\s+/g, ' ').slice(0, 90)}…`);
  }
  if (warmLat.length) {
    console.log(`  → warm median ${(median(warmLat) / 1000).toFixed(2)}s   bootstrap delta ≈ ${((cold.dt - median(warmLat)) / 1000).toFixed(2)}s`);
  }
}

(async () => {
  console.log('=== Warm-CLI Brain latency A/B ===');
  console.log(`claude bin: ${CLAUDE_BIN}`);
  console.log(`payload: ${CTX.length} chars context, ${CASES.length} questions\n`);

  // Flash-lite baseline (founder fast tier today)
  console.log('──── flash-lite HTTP (founder managed tier) ────');
  if (!OR_KEY) {
    console.log('  SKIP — OPENROUTER_API_KEY not set');
  } else {
    const flashLat: number[] = [];
    for (let i = 0; i < CASES.length; i += 1) {
      const r = await flashCall(buildPrompt(CASES[i]));
      if (r.err) { console.log(`  #${i + 1} ERROR: ${r.err.slice(0, 120)}`); continue; }
      flashLat.push(r.dt);
      console.log(`  #${i + 1} ${(r.dt / 1000).toFixed(2)}s   ${r.text.replace(/\s+/g, ' ').slice(0, 90)}…`);
    }
    if (flashLat.length) console.log(`  → flash-lite median ${(median(flashLat) / 1000).toFixed(2)}s`);
  }

  await measureWarmTier('warm Haiku', HAIKU);
  await measureWarmTier('warm Sonnet', SONNET);

  console.log('\n=== done ===');
  // Warm pool keeps idle procs + timers alive; exit explicitly.
  resetWarmReplPool();
  process.exit(0);
})();
