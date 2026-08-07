import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { withLockedState } from '@/lib/orchestrator/control-plane';
import {
  FILE_SIZE_BLOCK_THRESHOLD_LINES,
  FILE_SIZE_WAIVERS,
} from '@/lib/orchestrator/dispatch';
import { nextPacketReferenceLabel } from '@/lib/orchestrator/store';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
} from '@/lib/orchestrator/types';

const execFileAsync = promisify(execFile);

const DECOMPOSABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
]);

/**
 * Only one decomposition packet fires per merge — the largest ceiling
 * violation. Additional over-ceiling files are logged for the operator so
 * pre-existing ceiling debt remains visible, but are NOT enqueued. The next
 * merge that touches them will re-trigger the scan if they still qualify.
 */
const MAX_CANDIDATES_PER_MERGE = 1;

const DECOMPOSE_TEMPLATE_FILENAME = 'decompose.md';

export interface DecompositionCandidate {
  relativePath: string;
  absolutePath: string;
  lineCount: number;
  /** How many net lines this merge added to the file (after - before). */
  addedByMerge: number;
}

export interface EnqueueDecompositionResult {
  enqueued: number;
  mergeSha: string | null;
  candidates: DecompositionCandidate[];
  skipped: DecompositionCandidate[];
  preExistingDebt: DecompositionCandidate[];
}

function countLines(content: string): number {
  // Match wc -l: count newlines, add one only if the file doesn't end in
  // a newline. Keeps the ceiling comparison consistent with rule-check.
  const newlines = (content.match(/\n/g) ?? []).length;
  return newlines + (content.length > 0 && !content.endsWith('\n') ? 1 : 0);
}

async function resolveMergeSha(repoPath: string, mergeRef: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', mergeRef], {
      windowsHide: true,
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Return the line count a file had BEFORE the given commit by reading its
 * first parent (`<sha>^:<path>`). Returns 0 when the file did not exist pre-
 * merge (new file), and null when git can't answer (e.g. root commit) — callers
 * should treat null as "unknown, skip the pre-existing-debt check".
 */
async function readPreMergeLineCount(
  repoPath: string,
  sha: string,
  relativePath: string,
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${sha}^:${relativePath}`],
      { windowsHide: true, cwd: repoPath, maxBuffer: 16 * 1024 * 1024 },
    );
    return countLines(stdout);
  } catch (error) {
    // `git show` exits non-zero both for "file absent in parent" and "sha has
    // no parent". Use `git cat-file -e <sha>^` to distinguish: if the parent
    // exists, the file was simply new in the merge (→ pre-count 0). If there
    // is no parent, we can't run the diff — return null.
    try {
      await execFileAsync('git', ['cat-file', '-e', `${sha}^`], {
        windowsHide: true,
        cwd: repoPath,
        maxBuffer: 128 * 1024,
      });
      return 0;
    } catch {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[decomposition] Unable to resolve parent of ${sha} for ${relativePath}: ${message}`,
      );
      return null;
    }
  }
}

export async function findDecompositionCandidates(options: {
  repoPath: string;
  mergeSha: string;
}): Promise<{ candidates: DecompositionCandidate[]; preExistingDebt: DecompositionCandidate[] }> {
  const { repoPath, mergeSha } = options;

  let touchedFiles: string[];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', '--name-only', '--pretty=', mergeSha],
      { windowsHide: true, cwd: repoPath, maxBuffer: 4 * 1024 * 1024 },
    );
    touchedFiles = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    console.warn(
      `[decomposition] Failed to list files for ${mergeSha} in ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { candidates: [], preExistingDebt: [] };
  }

  const candidates: DecompositionCandidate[] = [];
  const preExistingDebt: DecompositionCandidate[] = [];
  const seen = new Set<string>();

  for (const relativePath of touchedFiles) {
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    if (FILE_SIZE_WAIVERS.has(relativePath)) continue;
    const ext = extname(relativePath).toLowerCase();
    if (!DECOMPOSABLE_EXTENSIONS.has(ext)) continue;

    const absolutePath = join(repoPath, relativePath);
    if (!existsSync(absolutePath)) continue;

    let postMergeLineCount: number;
    try {
      postMergeLineCount = countLines(readFileSync(absolutePath, 'utf8'));
    } catch {
      continue;
    }

    if (postMergeLineCount <= FILE_SIZE_BLOCK_THRESHOLD_LINES) {
      continue;
    }

    const preMergeLineCount = await readPreMergeLineCount(repoPath, mergeSha, relativePath);
    // `null` means we can't answer — treat as pre-existing debt so we err on
    // the side of NOT enqueueing cleanup that wasn't caused by this merge.
    if (preMergeLineCount === null) {
      preExistingDebt.push({
        relativePath,
        absolutePath,
        lineCount: postMergeLineCount,
        addedByMerge: 0,
      });
      continue;
    }

    const addedByMerge = postMergeLineCount - preMergeLineCount;
    const wasAlreadyOverCeiling = preMergeLineCount > FILE_SIZE_BLOCK_THRESHOLD_LINES;

    // Only fire when the merge ITSELF pushed the file over the ceiling. If
    // the file was already over before and the merge didn't add to it, that's
    // pre-existing debt for a different refactor to handle.
    const mergePushedOverCeiling = !wasAlreadyOverCeiling && addedByMerge > 0;
    const mergeMadeDebtWorse = wasAlreadyOverCeiling && addedByMerge > 0;

    if (mergePushedOverCeiling || mergeMadeDebtWorse) {
      candidates.push({
        relativePath,
        absolutePath,
        lineCount: postMergeLineCount,
        addedByMerge,
      });
    } else {
      preExistingDebt.push({
        relativePath,
        absolutePath,
        lineCount: postMergeLineCount,
        addedByMerge,
      });
    }
  }

  // Rank largest-overshoot first, with tie-break by total line count so the
  // hottest ceiling violation wins when two files added the same amount.
  candidates.sort((a, b) => b.addedByMerge - a.addedByMerge || b.lineCount - a.lineCount);
  return { candidates, preExistingDebt };
}

function candidateTemplatePaths(): string[] {
  // The template is read at runtime, not bundled, because the template evolves
  // out-of-band with the code. Layout varies across dev / Next standalone /
  // Tauri bundled, so probe the four known locations and take the first that
  // resolves. Always end with the cwd-relative source path for dev.
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, 'prompts', DECOMPOSE_TEMPLATE_FILENAME));
    candidates.push(join(here, '..', '..', '..', '..', 'prompts', DECOMPOSE_TEMPLATE_FILENAME));
  } catch {
    // ESM URL unavailable (unlikely on Node 22+). Fall through to cwd probes.
  }
  candidates.push(join(process.cwd(), 'prompts', DECOMPOSE_TEMPLATE_FILENAME));
  candidates.push(join(process.cwd(), 'src', 'lib', 'dispatch', 'prompts', DECOMPOSE_TEMPLATE_FILENAME));
  return candidates;
}

function loadTemplate(): { template: string | null; resolvedPath: string | null } {
  for (const candidate of candidateTemplatePaths()) {
    try {
      if (existsSync(candidate)) {
        return { template: readFileSync(candidate, 'utf8'), resolvedPath: candidate };
      }
    } catch {
      // keep probing
    }
  }
  return { template: null, resolvedPath: null };
}

function renderTemplate(template: string, replacements: Record<string, string | number>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key: string) => {
    const value = replacements[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function buildDecompositionPrompt(
  candidate: DecompositionCandidate,
  postMergeSha: string,
): string {
  const replacements = {
    targetFile: candidate.relativePath,
    lineCount: candidate.lineCount,
    ceiling: FILE_SIZE_BLOCK_THRESHOLD_LINES,
    postMergeSha: postMergeSha.slice(0, 12),
    basename: basename(candidate.relativePath),
  };

  const { template } = loadTemplate();
  if (template) {
    return renderTemplate(template, replacements);
  }

  // Template missing is a deployment bug (template not packaged with the
  // Tauri sidecar). Fall back to an inline version so the packet still gets
  // enqueued — a rough prompt is better than a silent drop. The warning
  // surfaces the packaging miss without stalling the loop.
  console.warn(
    `[decomposition] Prompt template unavailable in any probed location; falling back to inline prompt for ${candidate.relativePath}.`,
  );
  return [
    `Decompose \`${candidate.relativePath}\` (${candidate.lineCount} lines) into smaller modules, each under ${FILE_SIZE_BLOCK_THRESHOLD_LINES} lines. This is a PURE refactor — ZERO functional changes.`,
    '',
    `This packet was enqueued by the #538 post-merge decomposition pipeline because merge ${postMergeSha.slice(0, 12)} added lines pushing the file over the ceiling.`,
    '',
    'Approach: read the file end-to-end, extract hooks/subcomponents/types/utilities into sibling files, keep the original path as the public surface. Every new file must also stay under the ceiling. Inline styles only, no emoji, no CSS shorthand, raw SVG icons in the Tauri webview.',
    '',
    `Verify: \`npx tsc --noEmit\` and \`npm run rule-check\` both pass, no behaviour changes, single commit \`refactor: decompose ${basename(candidate.relativePath)} into modules\`.`,
    '',
    'If the file genuinely cannot be decomposed, stop and explain. Do not force unnatural splits — the packet will archive as failed and the operator can add a waiver.',
  ].join('\n');
}

function slugForDecomposeBranch(relativePath: string): string {
  const base = basename(relativePath).replace(extname(relativePath), '');
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'file';
}

function buildDecompositionPacket(
  candidate: DecompositionCandidate,
  context: {
    repoPath: string;
    runtime: OrchestratorRuntime;
    referenceLabel: string;
    postMergeSha: string;
  },
): OrchestratorPacket {
  const packetId = `decompose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = slugForDecomposeBranch(candidate.relativePath);
  const prompt = buildDecompositionPrompt(candidate, context.postMergeSha);
  return {
    id: packetId,
    referenceLabel: context.referenceLabel,
    title: `Decompose ${candidate.relativePath} (${candidate.lineCount} lines)`,
    summary: prompt,
    prompt,
    workspaceTargetPath: context.repoPath,
    branchTarget: `decompose/${slug}-${Date.now().toString(36)}`,
    runtime: context.runtime,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    packetType: 'decompose',
    decomposition: {
      targetFile: candidate.relativePath,
      postMergeSha: context.postMergeSha,
      lineCount: candidate.lineCount,
    },
  };
}

function hasExistingDecompositionPacket(
  state: OrchestratorMissionState,
  relativePath: string,
): boolean {
  const target = relativePath.trim();
  if (!target) return false;
  return state.packets.some((packet) => {
    if (packet.archivedAt || packet.releaseState === 'released') return false;
    if (packet.packetType === 'decompose' && packet.decomposition?.targetFile === target) {
      return true;
    }
    // Back-compat: old decomposition packets stored the path in the title only
    if (!packet.id.startsWith('decompose-')) return false;
    return packet.title.includes(target);
  });
}

/**
 * Scan the merge commit for files that this merge pushed over the ceiling,
 * then enqueue a single decomposition packet at the queue tail. Runs inside
 * withLockedState so it can't race the headless loop. Never throws — a failed
 * scan logs and returns zero enqueued, and the triggering merge is never
 * rolled back by a governance-layer failure.
 *
 * This is the platform compensation for weaker models that don't decompose
 * spontaneously. Strong models (Opus, Codex xhigh) typically ship files under
 * the ceiling, so this finds zero candidates and is a no-op. Weaker models
 * (gemini-flash, opencode-nano, Haiku) trip the scan and this picks up the
 * cleanup automatically — the platform enforces the rule regardless of model
 * tier.
 *
 * Behaviour contract (#538):
 * - Only fires when the merge ITSELF added lines that push a file over 800.
 *   Pre-existing debt (file was already over before the merge and this merge
 *   didn't add to it) is logged but skipped — that's for a different refactor.
 * - Maximum one decomposition packet per merge. Additional over-ceiling files
 *   are logged so the operator can see queued debt but only the largest
 *   overshoot is enqueued.
 * - The packet joins at the queue TAIL, not the head, so normal orchestrator
 *   work always drains first.
 */
export async function enqueueDecompositionsAfterMerge(options: {
  repoPath: string;
  runtime: OrchestratorRuntime;
  mergeRef?: string;
}): Promise<EnqueueDecompositionResult> {
  const mergeRef = options.mergeRef ?? 'HEAD';
  const mergeSha = await resolveMergeSha(options.repoPath, mergeRef);
  if (!mergeSha) {
    console.warn(
      `[decomposition] Unable to resolve merge SHA for ${mergeRef} in ${options.repoPath}; skipping scan.`,
    );
    return { enqueued: 0, mergeSha: null, candidates: [], skipped: [], preExistingDebt: [] };
  }

  let scan: { candidates: DecompositionCandidate[]; preExistingDebt: DecompositionCandidate[] };
  try {
    scan = await findDecompositionCandidates({
      repoPath: options.repoPath,
      mergeSha,
    });
  } catch (error) {
    console.warn(
      `[decomposition] Candidate scan failed for ${options.repoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { enqueued: 0, mergeSha, candidates: [], skipped: [], preExistingDebt: [] };
  }

  if (scan.preExistingDebt.length > 0) {
    const debtList = scan.preExistingDebt
      .map((entry) => `${entry.relativePath} (${entry.lineCount}L, pre-existing)`)
      .join(', ');
    console.log(
      `[decomposition] Merge ${mergeSha.slice(0, 12)} touched ${scan.preExistingDebt.length} over-ceiling file${scan.preExistingDebt.length === 1 ? '' : 's'} without adding lines — skipping as pre-existing debt: ${debtList}`,
    );
  }

  if (scan.candidates.length === 0) {
    console.log(
      `[decomposition] Scan clean for ${options.repoPath}@${mergeSha.slice(0, 12)} — no merge-caused ceiling violations.`,
    );
    return {
      enqueued: 0,
      mergeSha,
      candidates: [],
      skipped: [],
      preExistingDebt: scan.preExistingDebt,
    };
  }

  const capped = scan.candidates.slice(0, MAX_CANDIDATES_PER_MERGE);
  const skipped = scan.candidates.slice(MAX_CANDIDATES_PER_MERGE);
  if (skipped.length > 0) {
    const deferred = skipped
      .map((candidate) => `${candidate.relativePath} (+${candidate.addedByMerge}L, now ${candidate.lineCount}L)`)
      .join(', ');
    console.warn(
      `[decomposition] Merge ${mergeSha.slice(0, 12)} produced ${scan.candidates.length} ceiling violations; only enqueueing the largest (cap=${MAX_CANDIDATES_PER_MERGE}). Deferred: ${deferred}`,
    );
  }

  let enqueued = 0;
  const enqueuedCandidates: DecompositionCandidate[] = [];
  try {
    await withLockedState((state) => {
      for (const candidate of capped) {
        if (hasExistingDecompositionPacket(state, candidate.relativePath)) {
          continue;
        }
        const packet = buildDecompositionPacket(candidate, {
          repoPath: options.repoPath,
          runtime: options.runtime,
          referenceLabel: nextPacketReferenceLabel(state.packets),
          postMergeSha: mergeSha,
        });
        state.packets.push(packet);
        enqueued += 1;
        enqueuedCandidates.push(candidate);
      }
      if (enqueued > 0) {
        state.updatedAt = new Date().toISOString();
      }
    });
  } catch (error) {
    console.warn(
      `[decomposition] Failed to enqueue packets: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      enqueued: 0,
      mergeSha,
      candidates: [],
      skipped: scan.candidates,
      preExistingDebt: scan.preExistingDebt,
    };
  }

  if (enqueued > 0) {
    const fileList = enqueuedCandidates
      .map((candidate) => `${candidate.relativePath} (+${candidate.addedByMerge}L, now ${candidate.lineCount}L)`)
      .join(', ');
    console.log(
      `[decomposition] Enqueued ${enqueued} decomposition packet${enqueued === 1 ? '' : 's'} after merge ${mergeSha.slice(0, 12)} in ${options.repoPath}: ${fileList}`,
    );
  }

  return {
    enqueued,
    mergeSha,
    candidates: enqueuedCandidates,
    skipped,
    preExistingDebt: scan.preExistingDebt,
  };
}
