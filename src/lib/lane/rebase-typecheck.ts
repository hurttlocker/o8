import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { detectTypecheckSkip, isMissingTscOutput } from './typecheck-availability';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

const execFileAsync = promisify(execFile);

const TYPECHECK_TIMEOUT_MS = 120_000;
const TYPECHECK_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const TYPECHECK_OUTPUT_PREVIEW_CHARS = 2_000;
const DIAGNOSTIC_PATTERN = /\berror TS(\d+):/;
const INCLUDE_PATTERN_DETAIL = /Matched by include pattern .*tsconfig\.json/i;
const IGNORABLE_GHOST_FILE_CODE = '6053';

interface DiagnosticBlock {
  code: string;
  text: string;
}

export type LaneRebaseTypecheckResult =
  | { ok: true }
  | { ok: false; output: string };

export async function runLaneRebaseTypecheck(input: {
  cwd: string;
  actualBranch: string;
  logPrefix: string;
}): Promise<LaneRebaseTypecheckResult> {
  const skip = await detectTypecheckSkip(input.cwd);
  if (skip.skip) {
    console.warn(
      `[${input.logPrefix}] Skipping typecheck for ${input.actualBranch}: ${skip.reason}. ` +
        'Treating as pass so the merge does not loop the layer-1 auto-retry (#1255).',
    );
    return { ok: true };
  }
  try {
    const typecheck = cliInvocation('npx', ['tsc', '--noEmit']);
    await execFileAsync(typecheck.command, typecheck.args, {
      windowsHide: true,
      cwd: input.cwd,
      timeout: TYPECHECK_TIMEOUT_MS,
      maxBuffer: TYPECHECK_MAX_BUFFER_BYTES,
    });
    console.log(`[${input.logPrefix}] Typecheck passed for ${input.actualBranch}`);
    return { ok: true };
  } catch (error) {
    const output = extractTypecheckOutput(error);

    // Safety net: if node_modules existed but `npx tsc` still resolved to the
    // squatter package, the pre-check missed it — never treat that as a type
    // error (it would loop the auto-retry).
    if (isMissingTscOutput(output)) {
      console.warn(
        `[${input.logPrefix}] No local TypeScript compiler in ${input.actualBranch} worktree; skipping typecheck (#1255).`,
      );
      return { ok: true };
    }

    const diagnostics = splitDiagnosticBlocks(output);
    const ignorableDiagnostics = diagnostics.filter(isIgnorableGhostFileDiagnostic);

    // Rebased worktrees can inherit stale Next-generated route/file lists through
    // TypeScript's incremental state. Treating pure TS6053 include-pattern misses
    // as hard failures creates false-negative merge responses and double-dispatch loops.
    if (diagnostics.length > 0 && ignorableDiagnostics.length === diagnostics.length) {
      console.warn(
        `[${input.logPrefix}] Ignoring ${ignorableDiagnostics.length} TS6053 ghost-file diagnostic${ignorableDiagnostics.length === 1 ? '' : 's'} after rebase for ${input.actualBranch}; stale Next type cache would otherwise trigger a false-negative merge result and double-dispatch loop.`,
      );
      return { ok: true };
    }

    const preview = truncateTypecheckOutput(output);
    console.error(`[${input.logPrefix}] Typecheck failed for ${input.actualBranch}:\n${preview}`);
    return { ok: false, output: preview };
  }
}

function extractTypecheckOutput(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';
  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';

  return stdout || stderr || error.message || 'Unknown typecheck error';
}

function truncateTypecheckOutput(output: string) {
  return output.slice(0, TYPECHECK_OUTPUT_PREVIEW_CHARS) || 'Unknown typecheck error';
}

function splitDiagnosticBlocks(output: string): DiagnosticBlock[] {
  const blocks: DiagnosticBlock[] = [];
  let currentBlock: { code: string; lines: string[] } | null = null;

  for (const line of output.split('\n')) {
    const match = line.match(DIAGNOSTIC_PATTERN);
    if (match) {
      if (currentBlock) {
        blocks.push({
          code: currentBlock.code,
          text: currentBlock.lines.join('\n').trim(),
        });
      }
      currentBlock = { code: match[1], lines: [line] };
      continue;
    }

    if (currentBlock) {
      currentBlock.lines.push(line);
    }
  }

  if (currentBlock) {
    blocks.push({
      code: currentBlock.code,
      text: currentBlock.lines.join('\n').trim(),
    });
  }

  return blocks;
}

function isIgnorableGhostFileDiagnostic(block: DiagnosticBlock) {
  return block.code === IGNORABLE_GHOST_FILE_CODE && INCLUDE_PATTERN_DETAIL.test(block.text);
}
