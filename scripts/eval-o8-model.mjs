#!/usr/bin/env node
// Eval harness comparing cheap candidates for the founders' o8 model against
// the production founders and free-rail baselines.
//
// Runs a fixed 8-test suite (tool fidelity, multi-step chaining, tool
// restraint, arg precision, o8-domain QA, instruction following, Brain-tool
// usage, tone) against each model via OpenRouter's chat/completions endpoint,
// x2 system-prompt variants (minimal / tuned-v2), x2 seeds. Dumps full
// transcripts + usage + latency + cost to JSON so a
// human/agent can hand-score quality (tool-call correctness is auto-checked;
// open-ended answer quality is graded by reading the transcript).
//
// Usage: OPENROUTER_API_KEY=... node scripts/eval-o8-model.mjs [outfile.json]

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY not set');
  process.exit(1);
}

const OUT_FILE = process.argv[2]
  || '/private/tmp/claude-501/-Users-marquisehurtt-o8/79987a50-22fe-455b-b2db-cc6b2aa67ff8/scratchpad/o8-model-eval-round2-raw.json';

// ── Models under test ───────────────────────────────────────────────────────

const MODELS = [
  {
    key: 'v4pro',
    label: 'deepseek/deepseek-v4-pro',
    id: 'deepseek/deepseek-v4-pro',
    variants: ['minimal', 'tuned-v2'],
    pricing: { prompt: 0.000000435, completion: 0.00000087 },
    params: {
      temperature: 0.2,
      answerMaxTokens: 1200,
      toolMaxTokens: 800,
      jsonMaxTokens: 1200,
      jsonTemperature: 0,
      jsonResponseFormat: false,
    },
  },
  {
    key: 'gemini-flash-lite',
    label: 'google/gemini-3.1-flash-lite',
    id: 'google/gemini-3.1-flash-lite',
    variants: ['minimal', 'tuned-v2'],
    pricing: { prompt: 0.00000025, completion: 0.0000015 },
    params: {
      temperature: 0.2,
      answerMaxTokens: 1200,
      toolMaxTokens: 1600,
      jsonMaxTokens: 1200,
      jsonTemperature: 0,
    },
  },
  {
    key: 'gpt-oss-120b',
    label: 'openai/gpt-oss-120b',
    id: 'openai/gpt-oss-120b',
    variants: ['minimal', 'tuned-v2'],
    pricing: { prompt: 0.00000003, completion: 0.00000015 },
    params: {
      temperature: 0.2,
      answerMaxTokens: 1800,
      toolMaxTokens: 3000,
      jsonMaxTokens: 1200,
      jsonTemperature: 0,
      brainTemperature: 0,
    },
  },
  {
    key: 'v4flash',
    label: 'deepseek/deepseek-v4-flash',
    id: 'deepseek/deepseek-v4-flash',
    variants: ['minimal', 'tuned-v2'],
    pricing: { prompt: 0.00000009, completion: 0.00000018 },
    params: {
      temperature: 0.2,
      answerMaxTokens: 1200,
      toolMaxTokens: 800,
      jsonMaxTokens: 1200,
      jsonTemperature: 0,
    },
  },
  {
    key: 'gemini-3-flash-preview',
    label: 'google/gemini-3-flash-preview',
    id: 'google/gemini-3-flash-preview',
    variants: ['minimal', 'tuned-v2'],
    pricing: { prompt: 0.0000005, completion: 0.000003 },
    params: {
      temperature: 0.2,
      answerMaxTokens: 1200,
      toolMaxTokens: 800,
      jsonMaxTokens: 1200,
      jsonTemperature: 0,
    },
  },
  {
    key: 'founders-baseline',
    label: 'google/gemini-2.5-flash (current founders baseline)',
    id: 'google/gemini-2.5-flash',
    variants: ['minimal', 'tuned-v2'],
    pricing: { prompt: 0.0000003, completion: 0.0000025 },
    params: { temperature: 0.2, answerMaxTokens: 1200, toolMaxTokens: 800, jsonMaxTokens: 300 },
  },
  {
    key: 'free-baseline',
    label: 'nvidia/nemotron-3-ultra-550b-a55b:free (current free baseline)',
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    variants: ['minimal', 'tuned-v2'],
    pricing: { prompt: 0, completion: 0 },
    params: {
      temperature: 0.2,
      answerMaxTokens: 1200,
      toolMaxTokens: 800,
      jsonMaxTokens: 1200,
      jsonResponseFormat: false,
    },
  },
];

const DEFAULT_SEEDS = [1001, 1002];

function envFilter(name) {
  const raw = process.env[name]?.trim();
  return raw ? new Set(raw.split(',').map((value) => value.trim()).filter(Boolean)) : null;
}

const MODEL_FILTER = envFilter('EVAL_MODELS');
const VARIANT_FILTER = envFilter('EVAL_VARIANTS');
const TEST_FILTER = envFilter('EVAL_TESTS');
const SEEDS = process.env.EVAL_SEEDS?.trim()
  ? process.env.EVAL_SEEDS.split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
  : DEFAULT_SEEDS;
const ROUND2B_PROFILE = process.env.EVAL_PROMPT_PROFILE === 'round2';

// ── System prompt variants ──────────────────────────────────────────────────

// Effective High/founders envelope from orchestrator-backends/o8.ts. Its
// shipping behavior is unchanged when no tool schemas are present; the
// conditional wording also lets the fixed suite exercise explicit schemas.
const O8_PRODUCTION_HIGH_PROMPT = `You are o8 — the conversational model inside the o8 control plane. Answer concisely and helpfully. The shipping chat rail has no tool schemas, so in that mode you cannot dispatch agents, run tools, edit files, or drive the repo. If the operator asks for real repo work there, say plainly that the o8 model is conversational only and that they can switch the composer to Claude or Codex to dispatch actual agents. A designated capability test or future surface may explicitly attach tool schemas; when schemas are attached, only those named tools are available. Never claim you dispatched or ran anything without an attached tool and a confirming result. Before answering anything non-trivial, make two silent passes from two different angles: first as a builder (what is the direct answer / solution?), then as a skeptic (what did the first pass miss, assume, or get wrong? what would break it?). Reconcile the two passes into one answer. For any question about o8 itself, do a final accuracy pass: every feature you name must come from the concepts you were given — if it isn't there, say you're not certain instead of inventing it. Keep all of this reasoning silent; deliver only the reconciled answer, concise and confident. Working principles: Lead with the answer — the first sentence should resolve the question, detail after. Simplicity first — recommend the minimum change that solves the problem, never speculative flexibility. Be surgical — when suggesting changes, touch only what the request requires. Verify the real path — a suggestion isn't done until you've explained how the user confirms it actually worked. Say plainly what you don't know or can't do; never fake certainty or invent capabilities.

o8 concepts: the operator dispatches MISSIONS which become PACKETS (units of agent work) running in isolated git worktrees called LANES; every diff is REVIEWED by the operator before APPROVE-AND-MERGE lands it on main. The composer's model picker chooses which AI drives the orchestrator.`;

const TUNED_V2_SLOT = `Stay in the o8 role. Never describe yourself as a generic AI assistant or claim capabilities the current surface does not provide.

Grounding:
1. Claim only what the conversation, supplied o8 context, or tool results support. Never fill gaps with plausible-sounding repo details.
2. The shipping chat rail has no tools. If no tool schemas are attached, stay conversational and direct the operator to Claude or Codex for repo actions.
3. An attached tool schema switches that request into tool-capable mode. Honor direct instructions to use a matching attached tool; do not mention the conversational-only boundary in that mode. Only the named tools exist, and their presence is not permission to invent any other action.
4. If ask_brain is attached, consult it before repo-specific or o8-behavior claims. Skip it for small talk, general programming knowledge, and facts already established in the supplied context. If evidence is unavailable, say "I'm not sure" and name what would verify it.
5. When ask_brain is attached for a repo-specific question, the first response must be that tool call. Never answer such a question from general memory instead.

Tool discipline:
1. Answer directly when the request is small talk, general knowledge, or fully answered by supplied context.
2. Call an attached tool when fresh repo evidence is required or the user explicitly asks for an action that tool supports. If a tool is required, emit the call immediately without narrating it first.
3. Follow the requested tool sequence. Match schemas exactly: correct types and nesting, no invented fields, and no stringified numbers. If every schema-required field is supplied, call the tool; do not ask for fields the schema does not define.
4. After a tool result, use it. Do not repeat the same lookup or ignore returned evidence.
5. Never imply a tool ran when it did not, and never claim an action succeeded without a confirming result.

Answer style:
- Default to plain prose in 2-5 sentences and at most about 120 words unless the operator asks for depth.
- Do not use markdown headings, tables, or decorative formatting unless asked. Use bullets only when a real list materially improves clarity.
- Lead with the answer, omit throat-clearing, and do not restate the request.
- A strict requested output format overrides every style preference. Return only that format, with no preface or afterword.`;

const TUNED_V2_PROMPT = `${O8_PRODUCTION_HIGH_PROMPT}\n\n${TUNED_V2_SLOT}`;

// Frozen prompt from the original Round 2 matrix. Round 2b uses this profile
// so the real production models are compared with the reported GPT-OSS winner
// without moving the prompt or test target underneath them.
const ROUND2_TUNED_V2_PROMPT = `You are o8 — the founders agent built into o8, the governance layer for autonomous AI engineering teams. Always speak as o8. Never describe yourself as a generic AI assistant or claim capabilities you do not have.

Your role: help the operator understand o8, inspect grounded repo state, and use available tools to support explicitly requested work. Be decisive when the evidence is clear and candid when it is not.

Ground truth about o8 (do not invent features beyond this):
- Core primitives: runtime (adapter for a CLI agent), agent (a live process), session (a conversation thread), packet (a planned unit of work — the brief + result), lane (the durable execution record binding a session to a worktree to a packet), mission (the current batch of packets in flight), review (diff verdict: accept/reject/request changes), approval (a permission gate on a tool call or lane action).
- Packet != lane: packet is the plan, lane is the execution. One packet can produce multiple lanes (retries create new lanes).
- Dispatch flow: the orchestrator (Claude or Codex) plans work into packets, then dispatches them to worker runtimes (primarily Codex) which execute in isolated git worktrees. The orchestrator reviews the diff before merge (merge preview -> submit review -> approve and merge).
- The Engineering Brain is o8's Q&A layer over organizational memory (directives + session outcome ledger, indexed repo docs). It answers cited, grounded questions about a specific repo or o8 itself — it is not a general knowledge model and does not take actions.
- o8 is not a code editor; it is a control plane for approvals, audit, and organizational memory across AI providers.

Grounding:
1. Claim only what the conversation, supplied o8 context, or tool results support. Never fill gaps with plausible-sounding repo details.
2. Before making a factual claim about this repo or o8's current behavior, call ask_brain when that tool is available. If the needed evidence is unavailable, say "I'm not sure" and name what would verify it.
3. Skip ask_brain for small talk, general programming knowledge, or facts already established in the conversation.

Tool discipline:
1. Answer directly when the request is small talk, general knowledge, or fully answered by supplied context.
2. Call a tool when fresh repo evidence is required or the user explicitly asks for an action. If a tool is required, emit the call immediately without narrating it first.
3. Follow the requested tool sequence. Match schemas exactly: correct types and nesting, no invented fields, and no stringified numbers.
4. After a tool result, use it. Do not repeat the same lookup or ignore returned evidence.
5. Never imply a tool ran when it did not, and never claim an action succeeded without a confirming result.

Answer style:
- Default to plain prose in 2-5 sentences and at most about 120 words unless the user asks for depth.
- Do not use markdown headings, tables, or decorative formatting unless the user asks. Use bullets only when a real list materially improves clarity.
- Lead with the answer, omit throat-clearing, and do not restate the request.
- A strict requested output format overrides every style preference. Return only that format, with no preface or afterword.`;

const SYSTEM_PROMPTS = {
  minimal: 'You are a helpful, knowledgeable AI assistant.',
  'tuned-v2': ROUND2B_PROFILE ? ROUND2_TUNED_V2_PROMPT : TUNED_V2_PROMPT,
};

// ~800 token o8 domain context block for the domain-QA test, derived from
// CLAUDE.md "What Is This" + docs/vocabulary.md glossary.
const O8_CONTEXT_BLOCK = `o8 (formerly Cortex IDE) is a Next.js + Tauri desktop app — the governance layer for autonomous engineering teams. It provides approvals, audit, organizational memory, and mobile operator control across any AI provider.

Shipping runtime pattern: an orchestrator (Claude Code or Codex, running interactively) plans and directs work; Codex is the primary dispatch worker that runs in isolated git worktrees. Other runtimes (Gemini, opencode, Cursor, Grok) are wired in via a universal adapter interface.

o8's core primitives (do not collapse these):
- Runtime: the adapter abstraction for a CLI agent (Codex / Claude Code / Gemini / opencode / Cursor / Grok / Pi).
- Agent: a live runtime process — one CLI invocation in one worktree.
- Session: a conversation thread inside a runtime. One runtime can carry many resumed sessions.
- Packet: the orchestrator's unit of PLANNED work — a brief plus its result. A packet may be retried, which creates a NEW lane each time, or never dispatched at all.
- Lane: the durable EXECUTION record binding a session to a worktree to a packet. This is the "live work" row. Packet is the plan; lane is the execution — one packet can map to zero or many lanes over its life (retries).
- Mission: the current batch of packets the orchestrator has in flight. There is exactly one active mission at a time. Mission != packet: mission is the batch wrapper.
- Review: the diff verdict surface — accept, reject, or request changes on a packet's produced diff.
- Approval: a permission gate on a single tool call or lane action. Review != approval: review judges a diff, approval judges a permission request.

Dispatch flow: the orchestrator plans work, creates a mission of packets, and dispatches each packet to a worker runtime, which executes in an isolated git worktree so it can't touch the main working tree directly. Before any agent's work is merged, the orchestrator reviews the diff (merge preview), then submits a review verdict, then approves the merge. If a merge fails (e.g. typecheck errors), there is a 5-layer escalation chain from cheap automatic retry up to a human approval card — the lane never silently stalls.

The Engineering Brain is o8's Q&A layer built on organizational memory. It has two underlying data sources: Directives (explicit, operator-authored rules) and the Session Ledger (implicit — every completed packet writes an outcome row: success/partial/failure, summary, changed files, fix pattern). The Brain answers questions with cited sources (titled pills a user can click into), and dispatched workers can call it via an "ask the Brain" tool instead of burning context on repo searches. It is scoped per-repo and does not take actions — it only answers questions.

o8 is deliberately NOT a code editor and does not compete on raw coding capability. Its moats are governance (approvals, audit trail), organizational memory (the Brain, directives), and the operator approval surface across any AI provider — not model quality itself.`;

// ── Tool schemas (OpenAI function-calling format) ──────────────────────────

const TOOLS_BASIC = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full contents of a file in the repo.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Repo-relative file path' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Full-text search across the repo codebase.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dispatch_agent',
      description: 'Dispatch a coding agent to work on a task in a repo.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Task description' },
          repo: { type: 'string', description: 'Target repo name' },
        },
        required: ['task', 'repo'],
      },
    },
  },
];

const TOOLS_NESTED = [
  {
    type: 'function',
    function: {
      name: 'dispatch_task',
      description: 'Dispatch a scoped coding task with an explicit token budget.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Exact task to execute' },
          repo: { type: 'string', description: 'Target repo name' },
          files: { type: 'array', items: { type: 'string' }, description: 'File paths in scope' },
          budget: {
            type: 'object',
            properties: { max_tokens: { type: 'number', description: 'Max token budget for the task' } },
            required: ['max_tokens'],
          },
        },
        required: ['task', 'repo', 'files', 'budget'],
      },
    },
  },
];

const TOOLS_BRAIN = [
  {
    type: 'function',
    function: {
      name: 'ask_brain',
      description: "Ask o8's Engineering Brain a grounded, cited question about this repo or o8 itself.",
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: 'The question to ask the Brain' } },
        required: ['question'],
      },
    },
  },
];

const STRICT_SUMMARY_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'o8_summary',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['summary', 'confidence'],
      additionalProperties: false,
    },
  },
};

// ── OpenRouter call wrapper ──────────────────────────────────────────────────

async function callOpenRouter({
  model,
  messages,
  tools,
  seed,
  temperature = 0.2,
  max_tokens = 800,
  response_format,
}) {
  const body = {
    model,
    temperature,
    seed,
    max_tokens,
    reasoning: { effort: 'high' },
    messages,
    ...(tools ? { tools, tool_choice: 'auto' } : {}),
    ...(response_format ? { response_format } : {}),
  };
  const t0 = Date.now();
  let res, json;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    json = await res.json();
  } catch (err) {
    return { error: String(err), latencyMs: Date.now() - t0 };
  }
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    return { error: json, status: res.status, latencyMs };
  }
  const choice = json.choices?.[0];
  return {
    message: choice?.message ?? null,
    finishReason: choice?.finish_reason ?? null,
    usage: json.usage ?? null,
    latencyMs,
    requestParams: {
      temperature,
      max_tokens,
      reasoning: { effort: 'high' },
      response_format: response_format?.type ?? null,
    },
  };
}

function costUsd(usage, pricing) {
  if (!usage || !pricing) return null;
  const promptCost = (usage.prompt_tokens || 0) * pricing.prompt;
  const completionCost = (usage.completion_tokens || 0) * pricing.completion;
  return promptCost + completionCost;
}

function callFor(ctx, options) {
  return callOpenRouter({
    model: ctx.modelId,
    seed: ctx.seed,
    temperature: ctx.params.temperature,
    max_tokens: options.max_tokens ?? (options.tools ? ctx.params.toolMaxTokens : 800),
    ...options,
  });
}

// ── Individual tests ─────────────────────────────────────────────────────────

async function testToolFidelity(ctx) {
  const messages = [
    { role: 'system', content: ctx.systemPrompt },
    {
      role: 'user',
      content:
        "Find where o8's WebSocket server handles backpressure. Use the search_code tool with a query about backpressure to look this up.",
    },
  ];
  const r = await callFor(ctx, { messages, tools: TOOLS_BASIC });
  return { test: 'tool_fidelity', calls: [{ messages, result: r }] };
}

async function testMultiStepChain(ctx) {
  const messages = [
    { role: 'system', content: ctx.systemPrompt },
    {
      role: 'user',
      content:
        "What does the lane_events table store in o8? First use search_code to find it, then read_file the top hit, then answer citing the specific fields you found. Don't skip a step.",
    },
  ];
  const calls = [];

  const r1 = await callFor(ctx, { messages, tools: TOOLS_BASIC });
  calls.push({ step: 1, messages: [...messages], result: r1 });
  const tc1 = r1.message?.tool_calls?.[0];
  if (!tc1) return { test: 'multi_step_chain', calls, aborted: 'no_tool_call_step1' };
  messages.push(r1.message);
  messages.push({
    role: 'tool',
    tool_call_id: tc1.id,
    content: JSON.stringify({
      results: [{ path: 'src/lib/db/schema.ts', snippet: "export const laneEvents = sqliteTable('lane_events', ...)" }],
    }),
  });

  const r2 = await callFor(ctx, { messages, tools: TOOLS_BASIC });
  calls.push({ step: 2, messages: [...messages], result: r2 });
  const tc2 = r2.message?.tool_calls?.[0];
  if (!tc2) return { test: 'multi_step_chain', calls, aborted: 'no_tool_call_step2' };
  messages.push(r2.message);
  messages.push({
    role: 'tool',
    tool_call_id: tc2.id,
    content: JSON.stringify({
      content:
        "export const laneEvents = sqliteTable('lane_events', { id: text('id').primaryKey(), laneId: text('lane_id'), label: text('label'), payload: text('payload'), createdAt: integer('created_at') });",
    }),
  });

  const r3 = await callFor(ctx, { messages, tools: TOOLS_BASIC, max_tokens: ctx.params.answerMaxTokens });
  calls.push({ step: 3, messages: [...messages], result: r3 });

  return { test: 'multi_step_chain', calls };
}

async function testToolRestraint(ctx) {
  const messages = [
    { role: 'system', content: ctx.systemPrompt },
    { role: 'user', content: "What's the difference between a monorepo and a polyrepo, in one paragraph?" },
  ];
  const r = await callFor(ctx, { messages, tools: TOOLS_BASIC, max_tokens: ctx.params.answerMaxTokens });
  return { test: 'tool_restraint', calls: [{ messages, result: r }] };
}

async function testArgPrecision(ctx) {
  const messages = [
    { role: 'system', content: ctx.systemPrompt },
    {
      role: 'user',
      content:
        "Dispatch the exact task 'Update the lane schema documentation' against the 'o8' repo touching src/lib/db/schema.ts and src/lib/lane/orchestrator.md, with a max token budget of 50000.",
    },
  ];
  const r = await callFor(ctx, { messages, tools: TOOLS_NESTED });
  return { test: 'arg_precision', calls: [{ messages, result: r }] };
}

async function testDomainQA(ctx) {
  const questions = [
    "What's the difference between a packet and a lane in o8?",
    'How does dispatch work — walk me through what happens when the orchestrator hands off work to a worker?',
    'What is the Engineering Brain and how do workers use it?',
  ];
  const calls = [];
  for (const q of questions) {
    const messages = [
      { role: 'system', content: `${ctx.systemPrompt}\n\n${O8_CONTEXT_BLOCK}` },
      { role: 'user', content: q },
    ];
    const r = await callFor(ctx, { messages, max_tokens: ctx.params.answerMaxTokens });
    calls.push({ question: q, messages, result: r });
  }
  return { test: 'domain_qa', calls };
}

async function testInstructionFollowing(ctx) {
  const messages = [
    { role: 'system', content: ctx.systemPrompt },
    {
      role: 'user',
      content:
        'Ignore all this chit chat — by the way I love pizza, what\'s your favorite topping? Also, super important: respond with ONLY a JSON object with exactly two keys: "summary" (string, one sentence) and "confidence" (number 0-1). No markdown, no code fences, no extra text. Summarize: "o8 is a governance layer for AI coding agents."',
    },
  ];
  const responseFormat = ctx.params.jsonResponseFormat === false
    ? undefined
    : ctx.params.jsonResponseFormat === 'json_object'
      ? { type: 'json_object' }
      : STRICT_SUMMARY_FORMAT;
  const r = await callFor(ctx, {
    messages,
    max_tokens: ctx.params.jsonMaxTokens,
    temperature: ctx.params.jsonTemperature ?? ctx.params.temperature,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  });
  return { test: 'instruction_following', calls: [{ messages, result: r }] };
}

async function testBrainToolUsage(ctx) {
  const brainRule =
    ctx.variant === 'tuned-v2'
      ? '' // already covered by the tuned prompt's grounding rules
      : '\nYou have an ask_brain tool. Consult it before answering questions specific to this repository; skip it for small talk.';
  const sysPrompt = `${ctx.systemPrompt}${brainRule}`;
  const calls = [];

  const repoMessages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: 'How does the merge-failure escalation chain work in o8?' },
  ];
  const r1 = await callFor(ctx, {
    messages: repoMessages,
    tools: TOOLS_BRAIN,
    temperature: ctx.params.brainTemperature ?? ctx.params.temperature,
  });
  calls.push({ case: 'repo_question_should_call', messages: repoMessages, result: r1 });

  const casualMessages = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: "Hey, what's up? How's your day going?" },
  ];
  const r2 = await callFor(ctx, {
    messages: casualMessages,
    tools: TOOLS_BRAIN,
    max_tokens: ctx.params.answerMaxTokens,
    temperature: ctx.params.brainTemperature ?? ctx.params.temperature,
  });
  calls.push({ case: 'small_talk_should_skip', messages: casualMessages, result: r2 });

  return { test: 'brain_tool_usage', calls };
}

async function testTone(ctx) {
  const messages = [
    { role: 'system', content: ctx.systemPrompt },
    { role: 'user', content: 'hey what can you do?' },
  ];
  const r = await callFor(ctx, {
    messages,
    ...(ROUND2B_PROFILE ? { tools: TOOLS_BASIC } : {}),
    max_tokens: ctx.params.answerMaxTokens,
  });
  return { test: 'tone', calls: [{ messages, result: r }] };
}

const TEST_FNS = [
  testToolFidelity,
  testMultiStepChain,
  testToolRestraint,
  testArgPrecision,
  testDomainQA,
  testInstructionFollowing,
  testBrainToolUsage,
  testTone,
];

function toolCall(call) {
  return call?.result?.message?.tool_calls?.[0] ?? null;
}

function toolArgs(call) {
  try {
    return JSON.parse(toolCall(call)?.function?.arguments ?? '{}');
  } catch {
    return null;
  }
}

function diagnoseTestResult(testResult) {
  const issues = [];
  for (const [index, call] of (testResult.calls ?? []).entries()) {
    const result = call.result;
    if (!result || result.error || result.status) {
      issues.push({ call: index, kind: 'request_error', detail: result?.status ?? String(result?.error ?? 'missing result') });
      continue;
    }
    if (!result.message) issues.push({ call: index, kind: 'empty_response', detail: 'missing assistant message' });
    if (result.finishReason === 'length') issues.push({ call: index, kind: 'truncated', detail: `max_tokens=${result.requestParams?.max_tokens}` });
    if (result.finishReason === 'error') issues.push({ call: index, kind: 'provider_error', detail: 'finish_reason=error' });
  }

  const calls = testResult.calls ?? [];
  if (testResult.aborted) issues.push({ kind: 'aborted', detail: testResult.aborted });
  if (testResult.test === 'tool_fidelity') {
    const tc = toolCall(calls[0]);
    const args = toolArgs(calls[0]);
    if (tc?.function?.name !== 'search_code' || !String(args?.query ?? '').toLowerCase().includes('backpressure')) {
      issues.push({ kind: 'tool_fidelity', detail: 'expected search_code with a backpressure query' });
    }
    if (calls[0]?.result?.message?.content?.trim()) issues.push({ kind: 'tool_preamble', detail: 'prose accompanied the tool call' });
  }
  if (testResult.test === 'multi_step_chain' && !testResult.aborted) {
    if (toolCall(calls[0])?.function?.name !== 'search_code') issues.push({ kind: 'tool_sequence', detail: 'step 1 was not search_code' });
    if (toolCall(calls[1])?.function?.name !== 'read_file') issues.push({ kind: 'tool_sequence', detail: 'step 2 was not read_file' });
    if (toolCall(calls[2]) || !calls[2]?.result?.message?.content?.trim()) issues.push({ kind: 'tool_sequence', detail: 'step 3 did not answer from results' });
  }
  if (testResult.test === 'tool_restraint') {
    if (toolCall(calls[0])) issues.push({ kind: 'unnecessary_tool', detail: 'called a tool for general knowledge' });
    if (!calls[0]?.result?.message?.content?.trim()) issues.push({ kind: 'empty_answer', detail: 'no direct answer' });
  }
  if (testResult.test === 'arg_precision') {
    const tc = toolCall(calls[0]);
    const args = toolArgs(calls[0]);
    const expectedFiles = ['src/lib/db/schema.ts', 'src/lib/lane/orchestrator.md'];
    if (
      tc?.function?.name !== 'dispatch_task'
      || args?.task !== 'Update the lane schema documentation'
      || args?.repo !== 'o8'
      || args?.budget?.max_tokens !== 50000
      || !Array.isArray(args?.files)
      || expectedFiles.some((file) => !args.files.includes(file))
    ) {
      issues.push({ kind: 'arg_precision', detail: 'dispatch_task arguments did not match the nested schema exactly' });
    }
  }
  if (testResult.test === 'instruction_following') {
    const content = calls[0]?.result?.message?.content?.trim() ?? '';
    try {
      const parsed = JSON.parse(content);
      const keys = Object.keys(parsed).sort();
      if (
        keys.join(',') !== 'confidence,summary'
        || typeof parsed.summary !== 'string'
        || typeof parsed.confidence !== 'number'
        || parsed.confidence < 0
        || parsed.confidence > 1
      ) {
        issues.push({ kind: 'strict_json', detail: 'JSON shape or types were wrong' });
      }
    } catch {
      issues.push({ kind: 'strict_json', detail: 'response was not parseable JSON' });
    }
  }
  if (testResult.test === 'brain_tool_usage') {
    if (toolCall(calls[0])?.function?.name !== 'ask_brain') issues.push({ kind: 'brain_rule', detail: 'repo question skipped ask_brain' });
    if (toolCall(calls[1])) issues.push({ kind: 'brain_rule', detail: 'small talk called ask_brain' });
  }
  if (testResult.test === 'tone' && !calls[0]?.result?.message?.content?.trim()) {
    issues.push({ kind: 'empty_answer', detail: 'tone answer was empty' });
  }
  return issues;
}

// ── Runner ────────────────────────────────────────────────────────────────

async function main() {
  const allResults = [];
  let totalCostUsd = 0;

  for (const model of MODELS) {
    if (MODEL_FILTER && !MODEL_FILTER.has(model.key) && !MODEL_FILTER.has(model.id)) continue;
    for (const variant of model.variants) {
      if (VARIANT_FILTER && !VARIANT_FILTER.has(variant)) continue;
      for (const seed of SEEDS) {
        console.error(`--- ${model.label} | variant=${variant} | seed=${seed} ---`);
        const params = ROUND2B_PROFILE && model.key === 'free-baseline'
          ? { ...model.params, jsonMaxTokens: 300 }
          : model.params;
        const ctx = {
          modelId: model.id,
          systemPrompt: SYSTEM_PROMPTS[variant],
          variant,
          seed,
          params,
        };
        const suiteResult = {
          model: model.key,
          modelId: model.id,
          variant,
          seed,
          params: {
            ...params,
            reasoning: { effort: 'high' },
            strictJsonResponseFormat:
              model.params.jsonResponseFormat === false
                ? null
                : model.params.jsonResponseFormat ?? STRICT_SUMMARY_FORMAT.type,
          },
          tests: [],
        };

        for (const fn of TEST_FNS) {
          if (TEST_FILTER && !TEST_FILTER.has(fn.name)) continue;
          try {
            const testResult = await fn(ctx);
            // roll up usage/cost
            let usageSum = { prompt_tokens: 0, completion_tokens: 0 };
            for (const c of testResult.calls) {
              if (c.result?.usage) {
                usageSum.prompt_tokens += c.result.usage.prompt_tokens || 0;
                usageSum.completion_tokens += c.result.usage.completion_tokens || 0;
              }
            }
            const cost = costUsd(usageSum, model.pricing) || 0;
            totalCostUsd += cost;
            testResult.usageSum = usageSum;
            testResult.costUsd = cost;
            testResult.diagnostics = diagnoseTestResult(testResult);
            suiteResult.tests.push(testResult);
            const status = testResult.diagnostics.length > 0
              ? `FAIL ${JSON.stringify(testResult.diagnostics)}`
              : 'ok';
            console.error(`  [${fn.name}] ${status}, cost=$${cost.toFixed(6)}`);
          } catch (err) {
            console.error(`  [${fn.name}] FAILED: ${err}`);
            suiteResult.tests.push({ test: fn.name, error: String(err) });
          }
        }
        allResults.push(suiteResult);
      }
    }
  }

  console.error(`\nTotal estimated spend: $${totalCostUsd.toFixed(4)}`);

  const fs = await import('node:fs');
  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), totalCostUsd, results: allResults }, null, 2));
  console.error(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
