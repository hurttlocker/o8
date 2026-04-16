import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
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

// Cap the per-merge enqueue count so a single large merge cannot saturate the
// dispatch lane pool. Anything over this is surfaced as "skipped" and still
// visible to the operator in the lane-lifecycle event payload.
const MAX_CANDIDATES_PER_MERGE = 3;

export interface DecompositionCandidate {
  relativePath: string;
  absolutePath: string;
  lineCount: number;
}

export interface EnqueueDecompositionResult {
  enqueued: number;
  candidates: DecompositionCandidate[];
  skipped: DecompositionCandidate[];
}

export async function findDecompositionCandidates(options: {
  repoPath: string;
  mergeRef?: string;
}): Promise<DecompositionCandidate[]> {
  const { repoPath, mergeRef = 'HEAD' } = options;

  let touchedFiles: string[];
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', '--name-only', '--pretty=', mergeRef],
      { cwd: repoPath, maxBuffer: 4 * 1024 * 1024 },
    );
    touchedFiles = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    console.warn(
      `[decomposition] Failed to list files for ${mergeRef} in ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  const candidates: DecompositionCandidate[] = [];
  const seen = new Set<string>();
  for (const relativePath of touchedFiles) {
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    if (FILE_SIZE_WAIVERS.has(relativePath)) continue;
    const ext = extname(relativePath).toLowerCase();
    if (!DECOMPOSABLE_EXTENSIONS.has(ext)) continue;

    const absolutePath = join(repoPath, relativePath);
    if (!existsSync(absolutePath)) continue;

    let lineCount: number;
    try {
      const content = readFileSync(absolutePath, 'utf8');
      // Match wc -l: count newlines, add one only if the file doesn't end in
      // a newline. Keeps the ceiling comparison consistent with rule-check.
      const newlines = (content.match(/\n/g) ?? []).length;
      lineCount = newlines + (content.length > 0 && !content.endsWith('\n') ? 1 : 0);
    } catch {
      continue;
    }

    if (lineCount > FILE_SIZE_BLOCK_THRESHOLD_LINES) {
      candidates.push({ relativePath, absolutePath, lineCount });
    }
  }

  candidates.sort((a, b) => b.lineCount - a.lineCount);
  return candidates;
}

function buildDecompositionPrompt(candidate: DecompositionCandidate): string {
  return [
    `Decompose \`${candidate.relativePath}\` (${candidate.lineCount} lines) into smaller modules, each under ${FILE_SIZE_BLOCK_THRESHOLD_LINES} lines. This is a PURE refactor — ZERO functional changes.`,
    '',
    'Approach:',
    '1. Read the entire file first to understand its shape and public surface.',
    '2. Identify natural extraction boundaries — custom hooks, subcomponents, pure utilities, types/constants.',
    '3. Create new files in a sibling directory matching the file\'s role (components get `src/components/<area>/<feature>/<submodule>.tsx`, libs get `src/lib/<domain>/<submodule>.ts`).',
    '4. Keep the original file as the public surface — import sites MUST NOT change. Re-export from the original path if needed.',
    '5. Private types/utilities travel with the module that owns them. Only shared contracts stay at the original path.',
    '',
    'CLAUDE.md rules still apply (these are INVARIANTS, not suggestions):',
    '- Inline styles only — never className.',
    '- Longhand padding properties (paddingTop, paddingLeft) only. CSS shorthand is banned.',
    '- No emoji in code or comments.',
    '- Raw SVG in the Tauri webview — no lucide-react / phosphor-icons/react direct imports in src/components/desktop.',
    `- Every new file must also stay under ${FILE_SIZE_BLOCK_THRESHOLD_LINES} lines.`,
    '- Path aliases: @/* maps to ./src/*.',
    '- No hardcoded ports (3001 / 3002) or absolute home paths. Use process.env or os.homedir().',
    '',
    'Verification:',
    '- `npx tsc --noEmit` must pass with zero errors.',
    '- `npm run rule-check` must pass with zero violations.',
    '- No behavioural changes — every externally-observable UI, API, or store outcome must be identical before and after.',
    '',
    'Commit:',
    `- Single commit with message \`refactor: decompose ${basename(candidate.relativePath)} into modules\`.`,
    '',
    'If the file genuinely cannot be decomposed (e.g. a single tightly-coupled state machine with no natural seams), stop and leave a short note explaining why. Do not force unnatural splits.',
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
  context: { repoPath: string; runtime: OrchestratorRuntime; referenceLabel: string },
): OrchestratorPacket {
  const packetId = `decompose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = slugForDecomposeBranch(candidate.relativePath);
  return {
    id: packetId,
    referenceLabel: context.referenceLabel,
    title: `Decompose ${candidate.relativePath} (${candidate.lineCount} lines)`,
    summary: buildDecompositionPrompt(candidate),
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
    if (!packet.id.startsWith('decompose-')) return false;
    return packet.title.includes(target);
  });
}

/**
 * Scan the merge commit for files over the ceiling and enqueue a decomposition
 * packet for each. Runs inside withLockedState so it can't race the headless
 * loop. Never throws — a failed scan logs and returns zero enqueued.
 *
 * This is the platform compensation for weaker models that don't decompose
 * spontaneously. Strong models (Opus, Codex xhigh) typically ship files under
 * the ceiling, so this finds zero candidates and is a no-op. Weaker models
 * ship over-ceiling files and this picks up the cleanup automatically.
 */
export async function enqueueDecompositionsAfterMerge(options: {
  repoPath: string;
  runtime: OrchestratorRuntime;
  mergeRef?: string;
}): Promise<EnqueueDecompositionResult> {
  let all: DecompositionCandidate[];
  try {
    all = await findDecompositionCandidates({
      repoPath: options.repoPath,
      mergeRef: options.mergeRef,
    });
  } catch (error) {
    console.warn(
      `[decomposition] Candidate scan failed for ${options.repoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { enqueued: 0, candidates: [], skipped: [] };
  }

  if (all.length === 0) {
    console.log(`[decomposition] Scan clean for ${options.repoPath} — no over-ceiling files in the merge.`);
    return { enqueued: 0, candidates: [], skipped: [] };
  }

  const capped = all.slice(0, MAX_CANDIDATES_PER_MERGE);
  const skipped = all.slice(MAX_CANDIDATES_PER_MERGE);

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
    return { enqueued: 0, candidates: [], skipped: all };
  }

  if (enqueued > 0) {
    const fileList = enqueuedCandidates
      .map((candidate) => `${candidate.relativePath} (${candidate.lineCount} lines)`)
      .join(', ');
    console.log(
      `[decomposition] Enqueued ${enqueued} decomposition packet${enqueued === 1 ? '' : 's'} after merge in ${options.repoPath}: ${fileList}`
        + (skipped.length > 0
          ? ` (${skipped.length} additional candidate${skipped.length === 1 ? '' : 's'} deferred — per-merge cap is ${MAX_CANDIDATES_PER_MERGE})`
          : ''),
    );
  }

  return { enqueued, candidates: enqueuedCandidates, skipped };
}
