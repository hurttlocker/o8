/**
 * #2521 — the speculative-refill guard, proven at the REAL warm pool.
 *
 * The earlier opt-out tests mock `@/lib/claude-code/warm-repl-pool`, so they
 * cannot see the replacement proc that `askClaudeWarm` pre-spawns after it
 * serves a request. This suite leaves the pool intact and fakes only the
 * child-process boundary: every `spawn` returns an in-memory child that emits
 * a deterministic stream-json `result` frame when a turn writes to it and
 * never runs a real executable.
 *
 * That split lets the test distinguish the EXPLICIT proc (one stdin write) from
 * the idle REPLACEMENT (spawned but never written) and assert which one the
 * opt-out suppresses, through both real ask entry points (JSON
 * `/api/cortex/ask/answer` and streaming `/api/cortex/ask`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-brain-refill-'));
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-brain-refill-repo-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_CLAUDE_CODE_BIN = process.execPath;
process.env.O8_HYBRID_RETRIEVAL = '0';

const fixtures = vi.hoisted(() => ({ classifyClass: 'A' as 'A' | 'B' }));

interface FakeSpawnRecord {
  model: string;
  written: boolean;
  killed: boolean;
}

const harness = vi.hoisted(() => ({
  children: [] as FakeSpawnRecord[],
  held: [] as Array<() => void>,
  holdResults: false,
}));

const policy = vi.hoisted(() => ({
  calls: 0,
  impl: null as null | (() => boolean),
}));

// The real warm pool calls the caller's `refillPolicy` at the refill moment.
// Wrap the live predicate so the queued-race test can observe that the pool
// consulted it AFTER a queue wait (not merely once at call entry).
vi.mock('@/lib/operator/brain-routing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operator/brain-routing')>();
  policy.impl = actual.resolveBrainSpeculativeWarmupAllowedSync;
  return {
    ...actual,
    resolveBrainSpeculativeWarmupAllowedSync: vi.fn(() => {
      policy.calls += 1;
      return policy.impl!();
    }),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { promisify } = await import('node:util');

  class FakeChild extends EventEmitter {
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    readonly stdin: {
      write: (chunk: string, encoding: string, callback?: (error?: Error | null) => void) => boolean;
      end: () => void;
    };
    readonly pid: number;
    readonly model: string;
    killed = false;
    written = false;
    exitCode: number | null = null;

    constructor(model: string, pid: number) {
      super();
      this.model = model;
      this.pid = pid;
      this.stdin = {
        write: (_chunk, _encoding, callback) => {
          this.written = true;
          callback?.(null);
          return true;
        },
        end: () => {
          if (harness.holdResults) harness.held.push(() => this.emitResult());
          else queueMicrotask(() => this.emitResult());
        },
      };
    }

    emitResult(): void {
      if (this.killed) return;
      this.stdout.emit(
        'data',
        Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'fake warm answer' })}\n`),
      );
    }

    kill(): boolean {
      this.killed = true;
      return true;
    }
  }

  let pidSeq = 1;
  const spawn = (_command: string, args: string[] = []): FakeChild => {
    const modelIndex = args.indexOf('--model');
    const model = modelIndex >= 0 ? args[modelIndex + 1] ?? '' : '';
    const child = new FakeChild(model, pidSeq++);
    harness.children.push(child);
    return child;
  };

  // Discovery probe: `claude --version` (Sonnet tier detection). Binary
  // resolution uses the env override, so no real executable is reached.
  const execFile = Object.assign(
    (...args: unknown[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        (callback as (error: unknown, out: string, errOut: string) => void)(null, '/fixture/claude\n', '');
      }
      return undefined;
    },
    { [promisify.custom]: () => Promise.resolve({ stdout: '/fixture/claude\n', stderr: '' }) },
  );

  return {
    ...actual,
    spawn: spawn as unknown as typeof actual.spawn,
    execFile: execFile as unknown as typeof actual.execFile,
  };
});

vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({
  OPENROUTER_PRIMARY_MODEL: 'fixture/openrouter',
  OPENROUTER_FALLBACK_MODELS: ['fixture/openrouter-fallback'],
  resetOpenRouterCircuit: vi.fn(),
  isOpenRouterCircuitOpen: vi.fn(() => false),
  callOpenRouter: vi.fn(async () => JSON.stringify({
    class: fixtures.classifyClass,
    bm25_variants: ['refill fixture variant'],
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

const { getOperatorDefaultsSync, updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { askClaudeWarm, getWarmReplPoolTestState, resetWarmReplPool } = await import('@/lib/claude-code/warm-repl-pool');
const { getEntitlementPath } = await import('@/lib/entitlement/store');
const { invalidateAnswerCache } = await import('@/lib/cortex/qa/ask');
const { resetClassifierCache } = await import('@/lib/cortex/qa/classifier');
const { resetSonnetProviderCache } = await import('@/lib/cortex/qa/llm/sonnet-adapter');
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

function spawnedCount(): number { return harness.children.length; }
function writtenCount(): number { return harness.children.filter((child) => child.written).length; }
function idleReplacementCount(): number {
  return harness.children.filter((child) => !child.written && !child.killed).length;
}
function idleReplacementsAfter(index: number): number {
  return harness.children.slice(index).filter((child) => !child.written).length;
}

function releaseHeld(): void {
  harness.holdResults = false;
  const held = harness.held.splice(0);
  for (const emit of held) emit();
}

beforeAll(() => {
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
    projects: [{ id: 'refill-brain-route', name: 'Refill Brain Route', repoPaths: [repoPath], createdAt: now }],
    activeProjectId: 'refill-brain-route',
  }));
});

beforeEach(async () => {
  fixtures.classifyClass = 'A';
  policy.calls = 0;
  resetWarmReplPool();
  harness.children.length = 0;
  harness.held.length = 0;
  harness.holdResults = false;
  delete process.env.O8_BRAIN_WARMUP;
  resetClassifierCache();
  resetSonnetProviderCache();
  invalidateAnswerCache();
  rmSync(getEntitlementPath(), { force: true });
  await updateOperatorDefaults({
    brainRoutingMode: 'subscription',
    brainUseClaudeCli: true,
    brainWarmupEnabled: true,
    classAComposer: 'auto',
    judgmentProvider: 'off',
  });
  expect(getOperatorDefaultsSync().values.brainWarmupEnabled).toBe(true);
});

afterAll(() => {
  harness.holdResults = false;
  releaseHeld();
  resetWarmReplPool();
  delete process.env.O8_CLAUDE_CODE_BIN;
  delete process.env.O8_HYBRID_RETRIEVAL;
  delete process.env.O8_BRAIN_WARMUP;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe('Brain warmup opt-out guards real REPL refills', () => {
  it('disabled: an explicit JSON ask starts one requested proc and no idle replacement', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });

    const result = await jsonAsk('What does refill opt-out require for JSON?');

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true });
    expect(writtenCount()).toBe(1);
    expect(spawnedCount()).toBe(1);
    expect(idleReplacementCount()).toBe(0);
  });

  it('enabled positive control: an explicit JSON ask starts the requested proc plus one idle replacement', async () => {
    const result = await jsonAsk('What does refill enabled behavior require for JSON?');

    expect(result.status).toBe(200);
    expect(writtenCount()).toBe(1);
    expect(spawnedCount()).toBe(2);
    expect(idleReplacementCount()).toBe(1);
  });

  it('disabled: an explicit Class B streaming ask starts Sonnet with no idle replacement', async () => {
    fixtures.classifyClass = 'B';
    await updateOperatorDefaults({ brainWarmupEnabled: false });

    const result = await streamAsk('Explain why streaming Sonnet stays on the requested proc when opted out.');

    expect(result.status).toBe(200);
    expect(result.text).toContain('event: done');
    expect(writtenCount()).toBe(1);
    expect(spawnedCount()).toBe(1);
    expect(idleReplacementCount()).toBe(0);
  });

  it('enabled positive control: an explicit Class B streaming ask pre-spawns a replacement', async () => {
    fixtures.classifyClass = 'B';

    const result = await streamAsk('Explain why streaming Sonnet pre-spawns a replacement when enabled.');

    expect(result.status).toBe(200);
    expect(result.text).toContain('event: done');
    expect(writtenCount()).toBe(1);
    expect(idleReplacementCount()).toBeGreaterThanOrEqual(1);
  });

  it('disabled: sequential repeated JSON asks never leave an idle replacement', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });
    const question = 'What does repeated refill opt-out require?';

    const first = await jsonAsk(question);
    const second = await jsonAsk(question);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(writtenCount()).toBe(2);
    expect(spawnedCount()).toBe(2);
    expect(idleReplacementCount()).toBe(0);
  });

  it('disabled: concurrent JSON asks spawn only the explicitly requested procs', async () => {
    await updateOperatorDefaults({ brainWarmupEnabled: false });

    const results = await Promise.all([
      jsonAsk('Concurrent refill opt-out question alpha?'),
      jsonAsk('Concurrent refill opt-out question beta?'),
      jsonAsk('Concurrent refill opt-out question gamma?'),
    ]);

    for (const result of results) expect(result.status).toBe(200);
    expect(writtenCount()).toBe(3);
    expect(spawnedCount()).toBe(3);
    expect(idleReplacementCount()).toBe(0);
  });

  it('non-Brain callers that omit the policy retain the replacement refill', async () => {
    const result = await askClaudeWarm('Non-Brain callers retain their existing warm-pool behavior.', {
      binary: '/fixture/claude',
      model: 'fixture-non-brain',
    });

    expect(result).toBe('fake warm answer');
    expect(policy.calls).toBe(0);
    expect(writtenCount()).toBe(1);
    expect(spawnedCount()).toBe(2);
    expect(idleReplacementCount()).toBe(1);
  });

  it('queued calls re-evaluate policy at the refill moment: an opt-out landing during the queue suppresses the replacement', async () => {
    harness.holdResults = true;
    let pending: Array<ReturnType<typeof jsonAsk>> = [];
    try {
      const firstThree = [
        jsonAsk('Queued refill question one?'),
        jsonAsk('Queued refill question two?'),
        jsonAsk('Queued refill question three?'),
      ];
      pending = [...firstThree];
      await vi.waitFor(() => expect(writtenCount()).toBeGreaterThanOrEqual(3));

      // The fourth ask enters the real FIFO under the enabled policy. The
      // snapshot is an admission barrier: a predicate cached at call entry
      // would have captured `true` by this point, before we flip it below.
      expect(getOperatorDefaultsSync().values.brainWarmupEnabled).toBe(true);
      const fourth = jsonAsk('Queued refill question four, after the opt-out?');
      pending = [...firstThree, fourth];
      await vi.waitFor(() => expect(getWarmReplPoolTestState()).toMatchObject({
        activeTurns: 3,
        queuedTurns: 1,
      }));

      // The three held turns have already made their replacement decision.
      // Cursor after their work, then flip only once the fourth is confirmed
      // queued, so any replacement after this point belongs to the queued turn.
      const indexAtFlip = harness.children.length;
      const callsAtFlip = policy.calls;
      await updateOperatorDefaults({ brainWarmupEnabled: false });
      expect(getOperatorDefaultsSync().values.brainWarmupEnabled).toBe(false);
      releaseHeld();
      const results = await Promise.all(pending);

      for (const result of results) expect(result.status).toBe(200);
      // The queued call consulted the live policy at its refill moment...
      expect(policy.calls).toBeGreaterThan(callsAtFlip);
      // ...and left no replacement proc spawned after the opt-out.
      expect(idleReplacementsAfter(indexAtFlip)).toBe(0);
      // The explicit answer still ran on a real proc.
      expect(writtenCount()).toBeGreaterThanOrEqual(4);
    } finally {
      // Never leave a held turn (and its timer) dangling on a failed assertion.
      releaseHeld();
      await Promise.allSettled(pending);
      resetWarmReplPool();
    }
  });
});
