/**
 * #2521 — persistent opt-out for speculative Brain runtime warmup.
 *
 * Real-path doctrine: the setting is written through the real operator-defaults
 * store (settings.toml), then both ask entry points (JSON `/api/cortex/ask/answer`
 * and streaming `/api/cortex/ask`) run the real pipeline. The one boundary stubbed
 * is the warm REPL pool — that is exactly the speculative process spawn under
 * test, and its `prewarmClaudeRepl` / `askClaudeWarm` split lets us prove the
 * speculative spawn is suppressed while the explicit, required spawn still runs.
 *
 * Runtime/process discovery (`which`, `claude --version`) is stubbed with a
 * controllable probe so the in-flight race can be paused and released without
 * ever launching a provider subprocess.
 *
 * Managed-only: the entitlement file is persisted and the effective route is
 * resolved through the real entitlement store, proving the general enable
 * setting can never warm a subscription runtime on a managed-only plan.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-brain-warmup-'));
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-brain-warmup-repo-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
// Resolvable fake binary for the paths that read the env override directly.
process.env.O8_CLAUDE_CODE_BIN = process.execPath;
process.env.O8_HYBRID_RETRIEVAL = '0';

const fixtures = vi.hoisted(() => ({ classifyClass: 'A' as 'A' | 'B' }));

const probe = vi.hoisted(() => ({
  /** When true, discovery probes block until `releases` are flushed. */
  manual: false,
  releases: [] as Array<() => void>,
}));

// Replace every reached process-discovery boundary: `execFile` backs both
// `resolveClaudeBin` (which/login-shell) and `detectTier` (`--version`). No
// provider executable is ever invoked; `spawn`/`exec` stay real for unrelated
// libraries but the warm pool itself is mocked below.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const stdout = '/fixture/claude\n';
  const runProbe = (): Promise<{ stdout: string; stderr: string }> => {
    if (probe.manual) {
      return new Promise((resolve) => {
        probe.releases.push(() => resolve({ stdout, stderr: '' }));
      });
    }
    return Promise.resolve({ stdout, stderr: '' });
  };
  const customProbe = () => runProbe();
  const execFile = Object.assign(
    (...args: unknown[]) => {
      const callback = args[args.length - 1];
      void runProbe().then(
        (result) => {
          if (typeof callback === 'function') (callback as (err: unknown, out: string, errOut: string) => void)(null, result.stdout, result.stderr);
        },
        (error: unknown) => {
          if (typeof callback === 'function') (callback as (err: unknown, out: string, errOut: string) => void)(error, '', '');
        },
      );
      return undefined;
    },
    { [promisify.custom]: customProbe },
  );
  return { ...actual, execFile: execFile as unknown as typeof actual.execFile };
});

const pool = vi.hoisted(() => ({
  askClaudeWarm: vi.fn(async () => 'Warm pool answer.'),
  prewarmClaudeRepl: vi.fn(),
}));
vi.mock('@/lib/claude-code/warm-repl-pool', () => ({
  askClaudeWarm: pool.askClaudeWarm,
  prewarmClaudeRepl: pool.prewarmClaudeRepl,
  resetWarmReplPool: vi.fn(),
}));

vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({
  OPENROUTER_PRIMARY_MODEL: 'fixture/openrouter',
  OPENROUTER_FALLBACK_MODELS: ['fixture/openrouter-fallback'],
  resetOpenRouterCircuit: vi.fn(),
  isOpenRouterCircuitOpen: vi.fn(() => false),
  callOpenRouter: vi.fn(async () => JSON.stringify({
    class: fixtures.classifyClass,
    bm25_variants: ['warmup fixture variant'],
  })),
  warmupOpenRouter: vi.fn(async () => undefined),
}));
vi.mock('@/lib/cortex/qa/llm/codex-adapter', () => ({
  CODEX_DEFAULT_MODEL: 'fixture-codex',
  callCodex: vi.fn(async () => { throw new Error('codex stubbed'); }),
  resetCodexProviderCache: vi.fn(),
}));
vi.mock('@/lib/cortex/qa/llm/gemini-embed', () => ({
  EMBED_MODEL: 'fixture-embed',
  callEmbed: vi.fn(async () => null),
  embedQuestion: vi.fn(async () => null),
  hasEmbeddingRoute: vi.fn(() => false),
  unitNormalize: vi.fn(() => null),
  dot: vi.fn(() => 0),
}));

const { MODEL_IDS } = await import('@/lib/models');
const { getOperatorDefaultsSync, updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { resolveBrainWarmupEnabledSync } = await import('@/lib/operator/brain-routing');
const { getEntitlementPath } = await import('@/lib/entitlement/store');
const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
const { resetClassifierCache } = await import('@/lib/cortex/qa/classifier');
const { prewarmHaiku, resetHaikuProviderCache } = await import('@/lib/cortex/qa/llm/haiku-adapter');
const { prewarmSonnetCli, resetSonnetProviderCache } = await import('@/lib/cortex/qa/llm/sonnet-adapter');
const { parseOperatorDefaultsToml } = await import('@/lib/settings/toml');
const { getOperatorDefaultsTomlPath } = await import('@/lib/settings/operator-defaults-store');
const answerRoute = await import('@/app/api/cortex/ask/answer/route');
const askRoute = await import('@/app/api/cortex/ask/route');

const now = new Date().toISOString();

function jsonAsk(question: string) {
  return answerRoute.POST(new NextRequest('http://test.local/api/cortex/ask/answer', {
    method: 'POST',
    body: JSON.stringify({ question, repoPath, bypassCache: true }),
  })).then(async (res) => ({ status: res.status, body: await res.json() as Record<string, unknown> }));
}

async function streamAsk(question: string) {
  const res = await askRoute.POST(new NextRequest('http://test.local/api/cortex/ask?force=1', {
    method: 'POST',
    body: JSON.stringify({ question, repoPath, bypassCache: true }),
  }));
  return { status: res.status, text: await res.text() };
}

function warmupCallsForModel(model: string): number {
  return pool.prewarmClaudeRepl.mock.calls.filter((call) => call[1] === model).length;
}

function releaseDiscovery(): void {
  const pending = probe.releases.splice(0);
  for (const release of pending) release();
}

beforeAll(() => {
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'warmup-brain-route', name: 'Warmup Brain Route', repoPaths: [repoPath], createdAt: now }],
    activeProjectId: 'warmup-brain-route',
  }));
});

beforeEach(async () => {
  fixtures.classifyClass = 'A';
  delete process.env.O8_BRAIN_WARMUP;
  delete process.env.CLAUDE_BIN;
  process.env.O8_CLAUDE_CODE_BIN = process.execPath;
  probe.manual = false;
  releaseDiscovery();
  pool.askClaudeWarm.mockClear();
  pool.prewarmClaudeRepl.mockClear();
  resetHaikuProviderCache();
  resetSonnetProviderCache();
  resetClassifierCache();
  invalidateAnswerCache();
  rmSync(getEntitlementPath(), { force: true });
  await updateOperatorDefaults({
    brainRoutingMode: 'subscription',
    brainUseClaudeCli: true,
    brainWarmupEnabled: true,
    classAComposer: 'auto',
    judgmentProvider: 'off',
  });
});

afterAll(() => {
  probe.manual = false;
  releaseDiscovery();
  delete process.env.O8_CLAUDE_CODE_BIN;
  delete process.env.O8_HYBRID_RETRIEVAL;
  delete process.env.O8_BRAIN_WARMUP;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe('speculative Brain warmup opt-out', () => {
  it('warms the selected Haiku runtime by default and still runs the explicit ask (JSON entry point)', async () => {
    const result = await jsonAsk('What does warmup default behavior require?');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, class: 'A' });
    // Await the observable completion of the fire-and-forget warmup so no
    // asynchronous work bleeds into the next test.
    await vi.waitFor(() => expect(warmupCallsForModel(MODEL_IDS.claudeHaikuQaDefault)).toBeGreaterThan(0));
    expect(pool.askClaudeWarm).toHaveBeenCalled();
  });

  it('starts zero speculative runtimes once opted out, while the explicit ask still launches its runtime (JSON)', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });

    const result = await jsonAsk('What does warmup opt-out require?');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
    // The selected inference still starts when the answer actually needs it.
    expect(pool.askClaudeWarm).toHaveBeenCalled();
  });

  it('applies the persisted opt-out to the streaming ask entry point', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });

    const result = await streamAsk('What does streaming warmup opt-out require?');

    expect(result.status).toBe(200);
    expect(result.text).toContain('event: done');
    expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
    expect(pool.askClaudeWarm).toHaveBeenCalled();
  });

  it('pre-warms the Sonnet runtime for Class B when enabled and suppresses it when off', async () => {
    fixtures.classifyClass = 'B';
    pool.prewarmClaudeRepl.mockClear();
    await jsonAsk('Explain why Class B pre-warms Sonnet.');
    await vi.waitFor(() => expect(warmupCallsForModel(MODEL_IDS.claudeHaikuQaDefault)).toBeGreaterThan(0));
    await vi.waitFor(() => expect(warmupCallsForModel(MODEL_IDS.claudeQaDefault)).toBeGreaterThan(0));

    fixtures.classifyClass = 'B';
    await updateOperatorDefaults({ brainWarmupEnabled: false });
    pool.prewarmClaudeRepl.mockClear();
    await jsonAsk('Explain why Class B stays cold when opted out.');
    expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
  });

  it('keeps concurrent and repeated asks at zero speculative starts while opted out', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });

    const results = await Promise.all([
      jsonAsk('Concurrent opt-out question alpha?'),
      jsonAsk('Concurrent opt-out question beta?'),
      jsonAsk('Concurrent opt-out question gamma?'),
    ]);

    for (const result of results) expect(result.status).toBe(200);
    expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
    expect(pool.askClaudeWarm).toHaveBeenCalled();
  });

  it('keeps sequential repeated JSON and streaming asks on the same Class A question at zero speculative starts', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });
    const question = 'What does sequential Class A opt-out require?';

    const json1 = await jsonAsk(question);
    const json2 = await jsonAsk(question);
    const stream1 = await streamAsk(question);
    const stream2 = await streamAsk(question);

    expect(json1.status).toBe(200);
    expect(json2.status).toBe(200);
    expect(stream1.text).toContain('event: done');
    expect(stream2.text).toContain('event: done');
    expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
    expect(pool.askClaudeWarm).toHaveBeenCalled();
  });

  it('keeps sequential repeated JSON and streaming asks on the same Class B question at zero speculative starts', async () => {
    fixtures.classifyClass = 'B';
    await updateOperatorDefaults({ brainWarmupEnabled: false });
    const question = 'Explain why sequential Class B opt-out stays cold.';

    const json1 = await jsonAsk(question);
    const json2 = await jsonAsk(question);
    const stream1 = await streamAsk(question);
    const stream2 = await streamAsk(question);

    expect(json1.status).toBe(200);
    expect(json2.status).toBe(200);
    expect(stream1.text).toContain('event: done');
    expect(stream2.text).toContain('event: done');
    expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
    expect(pool.askClaudeWarm).toHaveBeenCalled();
  });

  it('never speculatively starts a subscription runtime on a managed-only plan, even with warmup enabled', async () => {
    writeFileSync(getEntitlementPath(), `${JSON.stringify({
      plan: 'pro',
      status: 'active',
      licenseKey: 'header.payload.signature',
    })}\n`);
    await updateOperatorDefaults({ brainRoutingMode: 'auto', brainUseClaudeCli: true, brainWarmupEnabled: true });

    await jsonAsk('What does managed-only warmup require?');

    expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
    expect(pool.askClaudeWarm).not.toHaveBeenCalled();
  });

  it('blocks an in-flight Haiku warmup when the opt-out lands during async discovery', async () => {
    delete process.env.O8_CLAUDE_CODE_BIN;
    resetHaikuProviderCache();
    pool.prewarmClaudeRepl.mockClear();
    probe.manual = true;

    try {
      const warmup = prewarmHaiku();
      await vi.waitFor(() => expect(probe.releases.length).toBeGreaterThan(0));
      await updateOperatorDefaults({ brainWarmupEnabled: false });
      releaseDiscovery();
      await warmup;
      expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
    } finally {
      probe.manual = false;
      releaseDiscovery();
      process.env.O8_CLAUDE_CODE_BIN = process.execPath;
    }
  });

  it('blocks an in-flight Sonnet warmup when the route turns managed during async discovery', async () => {
    process.env.O8_CLAUDE_CODE_BIN = process.execPath;
    resetSonnetProviderCache();
    pool.prewarmClaudeRepl.mockClear();
    probe.manual = true;

    try {
      const warmup = prewarmSonnetCli();
      await vi.waitFor(() => expect(probe.releases.length).toBeGreaterThan(0));
      writeFileSync(getEntitlementPath(), `${JSON.stringify({
        plan: 'pro',
        status: 'active',
        licenseKey: 'header.payload.signature',
      })}\n`);
      await updateOperatorDefaults({ brainRoutingMode: 'auto', brainUseClaudeCli: true, brainWarmupEnabled: true });
      releaseDiscovery();
      await warmup;
      expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();
    } finally {
      probe.manual = false;
      releaseDiscovery();
      rmSync(getEntitlementPath(), { force: true });
    }
  });

  it('enforces the opt-out at the adapter boundary so alternate speculative callers cannot bypass it', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });
    pool.prewarmClaudeRepl.mockClear();

    await prewarmHaiku();
    resetSonnetProviderCache();
    await prewarmSonnetCli();

    expect(pool.prewarmClaudeRepl).not.toHaveBeenCalled();

    // The opt-out gates warmup only — an explicit call still launches.
    pool.askClaudeWarm.mockClear();
    const { callHaiku } = await import('@/lib/cortex/qa/llm/haiku-adapter');
    await callHaiku('explicit question with warmup disabled');
    expect(pool.askClaudeWarm).toHaveBeenCalled();
  });

  it('persists the opt-out across reload and lets the documented env override win', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });

    expect(resolveBrainWarmupEnabledSync()).toBe(false);
    expect(getOperatorDefaultsSync().values.brainWarmupEnabled).toBe(false);
    expect(getOperatorDefaultsSync().sources.brainWarmupEnabled).toBe('file');
    expect(
      parseOperatorDefaultsToml(readFileSync(getOperatorDefaultsTomlPath(), 'utf8')).brainWarmupEnabled,
    ).toBe(false);

    process.env.O8_BRAIN_WARMUP = '1';
    try {
      expect(resolveBrainWarmupEnabledSync()).toBe(true);
      expect(getOperatorDefaultsSync().sources.brainWarmupEnabled).toBe('env');
    } finally {
      delete process.env.O8_BRAIN_WARMUP;
    }
  });
});
