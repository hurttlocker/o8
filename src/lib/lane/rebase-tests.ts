import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { ranUnconfined, runConfinedProcess } from '@/lib/sandbox/run-confined';

const TEST_TIMEOUT_MS = 300_000;
const TEST_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const TEST_OUTPUT_PREVIEW_CHARS = 3_000;

// create-react-app / bare scaffolds ship this as the `test` script; running it
// exits non-zero for reasons that have nothing to do with the merge. Treat as
// "no real test command" so we skip rather than false-fail the merge.
const PLACEHOLDER_TEST_SCRIPTS = new Set([
  'echo "error: no test specified" && exit 1',
  "echo 'error: no test specified' && exit 1",
]);

/** `unconfined` is set when the lane's tests ran without the sandbox because confinement is unavailable on this host. */
export type LaneRebaseTestResult =
  | { ok: true; skipped: boolean; unconfined?: true }
  | { ok: false; output: string; unconfined?: true };

/** One line for the merge card when the lane's tests ran without the sandbox (#3414). */
export const UNCONFINED_TESTS_NOTE = 'The lane\'s tests ran without the sandbox: command confinement is unavailable on this host.';

async function resolveTestScript(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const script = pkg.scripts?.test;
    if (typeof script !== 'string') return null;
    const trimmed = script.trim();
    if (!trimmed || PLACEHOLDER_TEST_SCRIPTS.has(trimmed.toLowerCase())) return null;
    return trimmed;
  } catch {
    // No package.json / unparseable — nothing to run.
    return null;
  }
}

/**
 * Run the repo's configured test command against a rebased worker branch. This
 * is the "does it still behave" check that typecheck can't give — the
 * different-files-clean-merge-but-broken-CI class. Opt-in and skip-safe: when
 * no real `test` script is configured we treat it as a pass so the merge does
 * not loop the layer-1 auto-retry.
 *
 * The test script is lane code, so it runs confined to the worktree (#3414):
 * no network, writes only in the worktree and a private TMPDIR, where the npm
 * and XDG caches also go. A toolchain that writes elsewhere (for example a
 * cache under a symlinked node_modules) fails here rather than being granted.
 */
export async function runLaneRebaseTests(input: {
  cwd: string;
  actualBranch: string;
  logPrefix: string;
}): Promise<LaneRebaseTestResult> {
  const script = await resolveTestScript(input.cwd);
  if (!script) {
    console.warn(
      `[${input.logPrefix}] No runnable test script for ${input.actualBranch}; skipping test replay (treated as pass).`,
    );
    return { ok: true, skipped: true };
  }

  try {
    // `npm` is `npm.cmd` on Windows, which execFile cannot run — the spawn
    // EINVALs before a test ever executes, and this function reads any failure
    // as "the tests failed". Same shape as the rebase typecheck gate: a merge
    // that should pass burns its layer-1 rerun and escalates instead.
    const testRun = cliInvocation('npm', ['test', '--silent']);
    const run = await runConfinedProcess(input.cwd, testRun.command, testRun.args, {
      cwd: input.cwd,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: TEST_MAX_BUFFER_BYTES,
    });
    console.log(`[${input.logPrefix}] Test replay passed for ${input.actualBranch}`);
    return { ok: true, skipped: false, ...(run.unconfined ? { unconfined: true as const } : {}) };
  } catch (error) {
    const output = extractTestOutput(error);
    const preview = output.slice(0, TEST_OUTPUT_PREVIEW_CHARS) || 'Unknown test failure';
    console.error(`[${input.logPrefix}] Test replay failed for ${input.actualBranch}:\n${preview}`);
    return { ok: false, output: preview, ...(ranUnconfined(error) ? { unconfined: true as const } : {}) };
  }
}

function extractTestOutput(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';
  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';
  return stdout || stderr || error.message || 'Unknown test failure';
}
