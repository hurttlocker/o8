/**
 * #800 — In-app demo-sequence runner.
 *
 * Drives the live o8 webview through the golden demo path so users can
 * sanity-check the app from Settings → Diagnostics without leaving o8.
 *
 * Steps (each step records pass/fail/skipped + ms + optional screenshot):
 *   1. Navigate to /dashboard → wait → screenshot
 *   2. Verify active route pathname === "/dashboard"
 *   3. Click the Orchestrator tab via screen coordinates
 *   4. Wait, screenshot, verify the chat surface shows a greeting
 *   5. Click the first quick-action card on the empty state
 *   6. Verify no NEW console errors fired between step 1 and step 6
 *
 * On any failure, subsequent steps are marked `skipped` (with a reason)
 * and we still return everything captured so the UI can show partial
 * progress. Total wall-clock budget is 30s — past that, the API route
 * returns 504 with whatever it managed to capture.
 *
 * Screenshots land under `<dataDir>/demo-runs/<ISO timestamp>/<step>.png`
 * (UTF-8 base64 → PNG buffer). We retain the most recent 10 runs and prune
 * older directories synchronously after a successful start.
 *
 * No destructive UI actions — we only navigate, click into safe surfaces,
 * and screenshot. The runner never sends, merges, deletes, or types text.
 */

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Public types ──

export type DemoStepStatus = 'pass' | 'fail' | 'skipped';

export interface DemoStepResult {
  name: string;
  status: DemoStepStatus;
  ms: number;
  screenshotPath?: string;
  message?: string;
}

export interface DemoRunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalSteps: number;
  passed: number;
  failed: number;
  skipped: number;
  runDir: string;
  steps: DemoStepResult[];
  truncated?: boolean;
}

// ── Internals ──

const ORCHESTRATOR_TAB_COORDS = { x: 199, y: 44 };
const QUICK_ACTION_COORDS = { x: 410, y: 200 };
const STEP_NAMES = [
  '01-navigate-dashboard',
  '02-verify-route',
  '03-click-orchestrator',
  '04-verify-greeting',
  '05-click-quick-action',
  '06-verify-no-errors',
] as const;
const RETAIN_RUNS = 10;

interface ConsoleErrorsPayload {
  errors: Array<{ message: string; source: string; lineno: number; timestamp: number }>;
  count: number;
  sinceLastFetch: number;
}

interface ActiveRoutePayload {
  pathname: string;
  search: string;
  hash: string;
  routerState: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isoForDirName(): string {
  // Filesystem-safe ISO: 2026-04-28T19-12-04-321Z
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function ensureRunDir(): Promise<{ runDir: string; rootDir: string }> {
  const rootDir = join(getDataDir(), 'demo-runs');
  await mkdir(rootDir, { recursive: true });
  const runDir = join(rootDir, isoForDirName());
  await mkdir(runDir, { recursive: true });
  return { runDir, rootDir };
}

async function pruneOldRuns(rootDir: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(rootDir);
  } catch {
    return;
  }
  const dirs: { name: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    try {
      const info = await stat(join(rootDir, name));
      if (info.isDirectory()) {
        dirs.push({ name, mtimeMs: info.mtimeMs });
      }
    } catch {
      // ignore unreadable entries
    }
  }
  if (dirs.length <= RETAIN_RUNS) return;

  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = dirs.slice(RETAIN_RUNS);
  for (const entry of toDelete) {
    try {
      await rm(join(rootDir, entry.name), { recursive: true, force: true });
    } catch {
      // best effort — never block the run on prune failures
    }
  }
}

async function captureScreenshot(
  client: O8WebviewClient,
  runDir: string,
  stepName: string,
): Promise<string | undefined> {
  try {
    const shot = await client.screenshot();
    const ext = shot.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const filePath = join(runDir, `${stepName}.${ext}`);
    await writeFile(filePath, Buffer.from(shot.imageBase64, 'base64'));
    return filePath;
  } catch {
    return undefined;
  }
}

/**
 * Runs the same Tauri-command shim the operator MCP server uses to read
 * o8_view_console_errors / o8_view_active_route. The data lives outside
 * the JS thread so it survives a busy webview and doesn't depend on any
 * in-flight UI work.
 */
async function invokeTauriCommand<T>(
  client: O8WebviewClient,
  command: string,
): Promise<T> {
  const code = `(() => { try {
    if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function') {
      return JSON.stringify({ ok: false, err: 'tauri internals unavailable' });
    }
    return window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})
      .then((r) => JSON.stringify({ ok: true, data: r }))
      .catch((e) => JSON.stringify({ ok: false, err: String(e && e.message || e) }));
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); } })()`;

  const { result } = await client.evalJs(code);
  let parsed: unknown = result;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error(`tauri invoke '${command}' returned non-JSON: ${String(result).slice(0, 200)}`);
  }
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { /* leave as is */ }
  }
  const envelope = parsed as { ok?: boolean; data?: unknown; err?: string };
  if (!envelope || envelope.ok !== true) {
    throw new Error(envelope?.err || `tauri invoke '${command}' failed`);
  }
  return envelope.data as T;
}

interface StepContext {
  client: O8WebviewClient;
  runDir: string;
  results: DemoStepResult[];
  baselineErrorCount: number;
}

async function timeStep(
  name: string,
  fn: () => Promise<{ message?: string; screenshotPath?: string }>,
): Promise<DemoStepResult> {
  const started = Date.now();
  try {
    const out = await fn();
    return {
      name,
      status: 'pass',
      ms: Date.now() - started,
      screenshotPath: out.screenshotPath,
      message: out.message,
    };
  } catch (err) {
    return {
      name,
      status: 'fail',
      ms: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function skippedStep(name: string, reason: string): DemoStepResult {
  return { name, status: 'skipped', ms: 0, message: reason };
}

// ── Steps ──

async function step1NavigateDashboard(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[0], async () => {
    await ctx.client.navigate('/dashboard');
    await sleep(2000);
    const screenshotPath = await captureScreenshot(ctx.client, ctx.runDir, STEP_NAMES[0]);
    return { screenshotPath };
  });
}

async function step2VerifyRoute(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[1], async () => {
    const route = await invokeTauriCommand<ActiveRoutePayload>(ctx.client, 'o8_view_active_route');
    if (route.pathname !== '/dashboard') {
      throw new Error(`expected pathname "/dashboard", got "${route.pathname}"`);
    }
    return { message: `pathname=${route.pathname}` };
  });
}

async function step3ClickOrchestrator(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[2], async () => {
    await ctx.client.click({ x: ORCHESTRATOR_TAB_COORDS.x, y: ORCHESTRATOR_TAB_COORDS.y });
    return { message: `click (${ORCHESTRATOR_TAB_COORDS.x},${ORCHESTRATOR_TAB_COORDS.y})` };
  });
}

async function step4VerifyGreeting(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[3], async () => {
    await sleep(1000);
    const screenshotPath = await captureScreenshot(ctx.client, ctx.runDir, STEP_NAMES[3]);
    const { text } = await ctx.client.readPage();
    const lower = text.toLowerCase();
    const matched = lower.includes('good morning')
      || lower.includes('good afternoon')
      || lower.includes('good evening')
      || lower.includes('orchestrator');
    if (!matched) {
      throw new Error('chat surface did not show a greeting/orchestrator marker');
    }
    return { screenshotPath, message: 'greeting/orchestrator marker present' };
  });
}

async function step5ClickQuickAction(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[4], async () => {
    await ctx.client.click({ x: QUICK_ACTION_COORDS.x, y: QUICK_ACTION_COORDS.y });
    return { message: `click (${QUICK_ACTION_COORDS.x},${QUICK_ACTION_COORDS.y})` };
  });
}

async function step6VerifyNoNewErrors(ctx: StepContext): Promise<DemoStepResult> {
  return timeStep(STEP_NAMES[5], async () => {
    await sleep(1500);
    const screenshotPath = await captureScreenshot(ctx.client, ctx.runDir, STEP_NAMES[5]);
    const errs = await invokeTauriCommand<ConsoleErrorsPayload>(ctx.client, 'o8_view_console_errors');
    const newSinceBaseline = Math.max(0, errs.count - ctx.baselineErrorCount);
    if (newSinceBaseline > 0) {
      const recent = errs.errors.slice(-3).map((e) => e.message).join(' | ');
      throw new Error(`${newSinceBaseline} new console error(s) since step 1: ${recent}`);
    }
    return {
      screenshotPath,
      message: `0 new errors since step 1 (total seen: ${errs.count})`,
    };
  });
}

// ── Orchestrator ──

/**
 * Resolve a promise to either its value or a sentinel timeout. We never
 * race against a hung webview: even on timeout we capture whatever steps
 * already finished and return them with `truncated: true`.
 */
async function withGlobalTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<{ value: T; timedOut: boolean }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolve(onTimeout());
    }, ms);
  });
  try {
    const value = await Promise.race([fn(), timeoutPromise]);
    return { value, timedOut };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function runDemoSequence(opts?: { timeoutMs?: number }): Promise<DemoRunResult> {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const timeoutMs = Math.max(5_000, Math.min(opts?.timeoutMs ?? 30_000, 60_000));

  const { runDir, rootDir } = await ensureRunDir();
  // Prune older folders before the new run so the directory stays tidy
  // even if the run errors out mid-flight.
  await pruneOldRuns(rootDir);

  const client = new O8WebviewClient();
  const results: DemoStepResult[] = [];
  let truncated = false;

  // Establish the console-error baseline up front. If the webview is
  // unreachable, every step after will fail quickly with the same root cause.
  let baselineErrorCount = 0;
  try {
    const initial = await invokeTauriCommand<ConsoleErrorsPayload>(client, 'o8_view_console_errors');
    baselineErrorCount = initial.count;
  } catch {
    baselineErrorCount = 0;
  }

  const ctx: StepContext = { client, runDir, results, baselineErrorCount };

  const runAll = async (): Promise<void> => {
    const steps: Array<(c: StepContext) => Promise<DemoStepResult>> = [
      step1NavigateDashboard,
      step2VerifyRoute,
      step3ClickOrchestrator,
      step4VerifyGreeting,
      step5ClickQuickAction,
      step6VerifyNoNewErrors,
    ];
    for (let i = 0; i < steps.length; i += 1) {
      const result = await steps[i](ctx);
      results.push(result);
      if (result.status === 'fail') {
        for (let j = i + 1; j < steps.length; j += 1) {
          results.push(skippedStep(STEP_NAMES[j], `skipped after ${result.name} failed`));
        }
        return;
      }
    }
  };

  await withGlobalTimeout(
    runAll,
    timeoutMs,
    () => {
      truncated = true;
      // Mark any unrecorded steps as skipped due to timeout.
      const recorded = new Set(results.map((r) => r.name));
      for (const name of STEP_NAMES) {
        if (!recorded.has(name)) {
          results.push(skippedStep(name, `skipped — overall ${timeoutMs}ms timeout reached`));
        }
      }
      return undefined as unknown as void;
    },
  );

  client.dispose();

  const finishedAt = nowIso();
  const durationMs = Date.now() - startedMs;
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  return {
    startedAt,
    finishedAt,
    durationMs,
    totalSteps: STEP_NAMES.length,
    passed,
    failed,
    skipped,
    runDir,
    steps: results,
    ...(truncated ? { truncated: true } : {}),
  };
}
