import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { readAttemptLearnings, type AttemptLearning } from '@/lib/orchestrator/attempt-log';
import { clearStaleLaneBinding, getDispatchableWave } from '@/lib/orchestrator/dag';
import { readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import { buildPacketSelfReviewInstructions } from '@/lib/orchestrator/self-review';
import {
  PRESERVATION_ADD_BUDGET_RATIO,
  PRESERVATION_DELETE_BUDGET_RATIO,
  PRESERVATION_MIN_DELETE_BUDGET,
} from '@/lib/lane/merge-gate';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { getAllCached, type FileSkeleton } from '@/lib/skeleton';
import { normalizeOrchestratorMissionState, packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type { OrchestratorLaneBinding, OrchestratorMissionState, OrchestratorPacket, PacketContext } from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

export const MAX_PARALLEL_DISPATCHES = 4;
export const MAX_RECOVERY_DISPATCHES = 2;
const RECOVERY_COOLDOWN_MS = 60_000;
export const FILE_SIZE_BLOCK_THRESHOLD_LINES = 800;
const FILE_SIZE_WARNING_BUFFER_LINES = 100;
const FILE_SIZE_WARNING_THRESHOLD_LINES = FILE_SIZE_BLOCK_THRESHOLD_LINES - FILE_SIZE_WARNING_BUFFER_LINES;
const MAX_THRESHOLD_GUIDANCE_FILES = 6;
const PATH_TEXT_CHAR_PATTERN = /[A-Za-z0-9._/-]/;
const SESSION_RECOVERY_COMMIT_MESSAGE = 'auto-commit: session recovery';
const execFileAsync = promisify(execFile);

/**
 * Files explicitly allowed to exceed the 600-line threshold.
 * These are layout orchestrators, multiplexers, or other files whose
 * size is inherent to their role (wiring many hooks/components together).
 * Relative paths from repo root, forward-slash separated.
 */
export const FILE_SIZE_WAIVERS = new Set([
  'src/app/dashboard/page.tsx',   // Layout orchestrator — wires 10+ hooks, providers, JSX tree
  'src/ws-server.ts',             // WebSocket multiplexer — channel handlers are co-located by design
]);

function formatChangedFiles(changedFiles: string[]) {
  if (changedFiles.length === 0) {
    return 'none recorded';
  }
  if (changedFiles.length <= 6) {
    return changedFiles.join(', ');
  }
  return `${changedFiles.slice(0, 6).join(', ')} (+${changedFiles.length - 6} more)`;
}

function formatInlinePromptList(items: string[], maxItems = 4) {
  if (items.length === 0) {
    return '';
  }
  if (items.length <= maxItems) {
    return items.join('; ');
  }
  return `${items.slice(0, maxItems).join('; ')} (+${items.length - maxItems} more)`;
}

function formatPacketReviewFallback(packet: OrchestratorPacket): string[] {
  const review = packet.review;
  if (!review) {
    return [];
  }

  const findings = review.findings.map((finding) => {
    const location = typeof finding.line === 'number' ? `${finding.file}:${finding.line}` : finding.file;
    return `${location} [${finding.severity}] ${finding.description} -> ${finding.resolution}`;
  });

  return [
    `Dependency review verdict: ${review.approved ? 'approved' : 'changes requested'}`,
    review.summary ? `Review summary: ${truncateText(review.summary, 800)}` : null,
    findings.length > 0 ? `Review findings: ${truncateText(findings.join(' | '), 1_000)}` : null,
  ].filter((value): value is string => Boolean(value));
}

function formatContextReviewFindings(reviewFindings: PacketContext['reviewFindings']) {
  if (!reviewFindings || reviewFindings.length === 0) {
    return '';
  }

  return formatInlinePromptList(
    reviewFindings.map((finding) => {
      const location = finding.file && finding.file !== 'unknown'
        ? (typeof finding.line === 'number' ? `${finding.file}:${finding.line}` : finding.file)
        : null;
      const description = truncateText(finding.description, 180);
      return location ? `${location} ${description}` : description;
    }),
    3,
  );
}

function buildReviewLessonSections(
  dependencyTitle: string,
  context: PacketContext,
): string[] {
  const sections: string[] = [];

  if (context.reviewFindings && context.reviewFindings.length > 0) {
    sections.push(
      `Lessons from prior agents: Agent working on '${dependencyTitle}' had ${context.reviewFindings.length} review finding${context.reviewFindings.length === 1 ? '' : 's'} caught during review: ${formatContextReviewFindings(context.reviewFindings)}. Watch for similar patterns.`,
    );
  }

  if (context.patterns && context.patterns.length > 0) {
    sections.push(
      `Patterns to follow: ${formatInlinePromptList(context.patterns.map((pattern) => truncateText(pattern, 180)), 4)}`,
    );
  }

  if (context.conflictZones && context.conflictZones.length > 0) {
    sections.push(
      `Conflict zone warnings: Files modified by dependency: ${formatInlinePromptList(context.conflictZones, 4)}`,
    );
  }

  return sections;
}

function extractAttemptLearningErrors(typecheckOutput?: string): string[] {
  if (!typecheckOutput?.trim()) {
    return [];
  }

  const seen = new Set<string>();
  return typecheckOutput
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => truncateText(line.trim(), 220, { normalizeWhitespace: true }))
    .filter((line) => line.length > 0 && /error\b/i.test(line))
    .filter((line) => {
      if (seen.has(line)) {
        return false;
      }
      seen.add(line);
      return true;
    })
    .slice(0, 3);
}

function buildAttemptLearningSections(learnings: AttemptLearning[]): string[] {
  return [...learnings]
    .sort((left, right) => left.attempt - right.attempt)
    .flatMap((learning) => {
      const keyErrors = extractAttemptLearningErrors(learning.typecheckOutput);
      return [
        `Attempt ${learning.attempt}: ${truncateText(learning.summary, 500, { normalizeWhitespace: true })}`,
        keyErrors.length > 0 ? `Key errors: ${truncateText(keyErrors.join(' | '), 1_000)}` : null,
        learning.filesChanged.length > 0 ? `Files implicated: ${formatInlinePromptList(learning.filesChanged, 4)}` : null,
      ].filter((value): value is string => Boolean(value));
    });
}

function buildPacketScopeText(packet: OrchestratorPacket): string {
  return [packet.title, packet.summary]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function hasPathTokenBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return true;
  }
  return !PATH_TEXT_CHAR_PATTERN.test(text[index] ?? '');
}

function includesPathToken(text: string, candidate: string): boolean {
  let fromIndex = 0;

  while (fromIndex < text.length) {
    const matchIndex = text.indexOf(candidate, fromIndex);
    if (matchIndex === -1) {
      return false;
    }

    const beforeIndex = matchIndex - 1;
    const afterIndex = matchIndex + candidate.length;
    if (hasPathTokenBoundary(text, beforeIndex) && hasPathTokenBoundary(text, afterIndex)) {
      return true;
    }

    fromIndex = matchIndex + candidate.length;
  }

  return false;
}

function packetMentionsSkeletonFile(scopeText: string, file: FileSkeleton): boolean {
  const normalizedPath = file.relativePath.toLowerCase();
  if (includesPathToken(scopeText, normalizedPath)) {
    return true;
  }

  let directoryPath = dirname(file.relativePath).replace(/\\/g, '/').toLowerCase();
  while (directoryPath && directoryPath !== '.') {
    if (includesPathToken(scopeText, `${directoryPath}/`)) {
      return true;
    }

    const parentDirectory = dirname(directoryPath).replace(/\\/g, '/').toLowerCase();
    if (parentDirectory === directoryPath) {
      break;
    }
    directoryPath = parentDirectory;
  }

  return false;
}

function formatThresholdFiles(files: FileSkeleton[]): string {
  if (files.length === 0) {
    return '';
  }

  const sorted = [...files].sort((left, right) => (
    right.lineCount - left.lineCount || left.relativePath.localeCompare(right.relativePath)
  ));

  if (sorted.length <= MAX_THRESHOLD_GUIDANCE_FILES) {
    return sorted.map((file) => `${file.relativePath} (${file.lineCount}L)`).join(', ');
  }

  return `${sorted.slice(0, MAX_THRESHOLD_GUIDANCE_FILES).map((file) => `${file.relativePath} (${file.lineCount}L)`).join(', ')} (+${sorted.length - MAX_THRESHOLD_GUIDANCE_FILES} more)`;
}

export function checkFileSizeThresholds(packet: OrchestratorPacket): string[] {
  const repoPath = packet.workspaceTargetPath;
  if (!repoPath) {
    return [];
  }

  const scopeText = buildPacketScopeText(packet);
  if (!scopeText) {
    return [];
  }

  const matchedFiles = getAllCached(repoPath).filter((file) => packetMentionsSkeletonFile(scopeText, file));
  if (matchedFiles.length === 0) {
    return [];
  }

  // Filter out waived files — layout orchestrators and multiplexers that are
  // legitimately large due to their architectural role
  const nonWaivedFiles = matchedFiles.filter((file) => !FILE_SIZE_WAIVERS.has(file.relativePath));

  const blockFiles = nonWaivedFiles.filter((file) => file.lineCount > FILE_SIZE_BLOCK_THRESHOLD_LINES);
  const warningFiles = nonWaivedFiles.filter((file) => (
    file.lineCount > FILE_SIZE_WARNING_THRESHOLD_LINES
    && file.lineCount <= FILE_SIZE_BLOCK_THRESHOLD_LINES
  ));

  if (blockFiles.length === 0 && warningFiles.length === 0) {
    return [];
  }

  return [
    'File size governance:',
    blockFiles.length > 0
      ? `Block threshold hit (> ${FILE_SIZE_BLOCK_THRESHOLD_LINES} lines): ${formatThresholdFiles(blockFiles)}.`
      : null,
    warningFiles.length > 0
      ? `Warning threshold hit (> ${FILE_SIZE_WARNING_THRESHOLD_LINES} lines): ${formatThresholdFiles(warningFiles)}.`
      : null,
    `Decompose before implementing. Extract a helper, module, or split responsibility before adding significant new logic to flagged files.`,
    `If a flagged file still needs edits, keep the diff surgical and surface any required follow-up refactor, review handoff, or operator decision explicitly.`,
  ].filter((value): value is string => Boolean(value));
}

const PRESERVATION_MAX_EXPORTS = 12;

function formatExportList(symbols: FileSkeleton['symbols']): string {
  const exported = symbols.filter((s) => s.exported);
  if (exported.length === 0) {
    return '';
  }

  const lines = exported
    .slice(0, PRESERVATION_MAX_EXPORTS)
    .map((s) => `  - ${truncateText(s.signature, 120)}`);

  if (exported.length > PRESERVATION_MAX_EXPORTS) {
    lines.push(`  - (+${exported.length - PRESERVATION_MAX_EXPORTS} more exports)`);
  }

  return lines.join('\n');
}

/**
 * Build a preservation envelope for existing files referenced by this packet.
 * Injects diff budgets + structural contracts so agents don't rewrite files.
 * (#482) — Proved effective in Round 2 dogfooding: P3 was a clean merge.
 */
export function buildPreservationEnvelope(packet: OrchestratorPacket): string[] {
  const repoPath = packet.workspaceTargetPath;
  if (!repoPath) {
    return [];
  }

  const scopeText = buildPacketScopeText(packet);
  if (!scopeText) {
    return [];
  }

  const matchedFiles = getAllCached(repoPath).filter((file) => packetMentionsSkeletonFile(scopeText, file));
  if (matchedFiles.length === 0) {
    return [];
  }

  // Only envelope files that actually exist and have content — new files get no envelope
  const existingFiles = matchedFiles.filter((file) => file.lineCount > 0);
  if (existingFiles.length === 0) {
    return [];
  }

  const sections: string[] = ['File preservation contracts (DO NOT REWRITE existing files):'];

  for (const file of existingFiles.slice(0, MAX_THRESHOLD_GUIDANCE_FILES)) {
    const addBudget = Math.ceil(file.lineCount * PRESERVATION_ADD_BUDGET_RATIO);
    const deleteBudget = Math.max(PRESERVATION_MIN_DELETE_BUDGET, Math.ceil(file.lineCount * PRESERVATION_DELETE_BUDGET_RATIO));
    const exportList = formatExportList(file.symbols);

    sections.push(
      `${file.relativePath} (${file.lineCount} lines):`,
      `  DIFF BUDGET: add up to ${addBudget} lines, delete no more than ${deleteBudget} existing lines.`,
      `  Make surgical additions only — do not rewrite or reorganize existing code.`,
    );

    if (exportList) {
      sections.push(
        `  STRUCTURAL CONTRACT — these exports MUST be preserved:`,
        exportList,
      );
    }
  }

  sections.push('If your task cannot be completed within these budgets, surface it as a blocker to the operator.');

  return sections;
}

async function buildDependencyContextSections(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): Promise<string[]> {
  if (packet.dependencyPacketIds.length === 0) {
    return [];
  }

  const packetById = new Map(allPackets.map((candidate) => [candidate.id, candidate]));
  const results = await Promise.allSettled(
    packet.dependencyPacketIds.map(async (dependencyPacketId) => {
      const dependencyPacket = packetById.get(dependencyPacketId);
      const context = await readPacketCompletionContext(dependencyPacketId);
      return { context, dependencyPacket, dependencyPacketId };
    }),
  );

  return results
    .filter((result): result is PromiseFulfilledResult<{
      context: Awaited<ReturnType<typeof readPacketCompletionContext>>;
      dependencyPacket: OrchestratorPacket | undefined;
      dependencyPacketId: string;
    }> => result.status === 'fulfilled')
    .flatMap(({ value }) => {
      const dependencyTitle = value.dependencyPacket?.title
        ?? value.dependencyPacket?.referenceLabel
        ?? value.dependencyPacketId;
      const reviewSections = value.context
        ? buildReviewLessonSections(dependencyTitle, value.context)
        : value.dependencyPacket
          ? formatPacketReviewFallback(value.dependencyPacket)
          : [];

      if (!value.context) {
        return reviewSections.length > 0
          ? [
              `Dependency '${dependencyTitle}' review context:`,
              ...reviewSections,
            ]
          : [];
      }

      return [
        `Previous work from dependency '${dependencyTitle}': ${truncateText(value.context.summary, 1_000)}`,
        `Files changed: ${formatChangedFiles(value.context.changedFiles)}`,
        ...reviewSections,
      ];
    });
}

async function buildPacketPrompt(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
  baseBranch = 'main',
  worktreePath?: string | null,
) {
  const dependencySections = await buildDependencyContextSections(packet, allPackets);
  const priorAttemptLearningSections = packet.attemptCount && packet.attemptCount > 0 && worktreePath?.trim()
    ? buildAttemptLearningSections(await readAttemptLearnings(worktreePath))
    : [];
  const fileSizeSections = checkFileSizeThresholds(packet);
  const preservationSections = buildPreservationEnvelope(packet);
  if (dependencySections.length > 0) {
    console.log(`[context-relay] Injected dependency context for packet ${packet.id}`);
  }
  if (priorAttemptLearningSections.length > 0) {
    console.log(`[dispatch] Injected prior attempt learnings for packet ${packet.id}`);
  }
  if (fileSizeSections.length > 0) {
    console.log(`[dispatch] Injected file size governance guidance for packet ${packet.id}`);
  }
  if (preservationSections.length > 0) {
    console.log(`[dispatch] Injected preservation envelope for packet ${packet.id} (${preservationSections.length - 2} files)`);
  }

  return [
    `Packet: ${packet.title}`,
    packet.summary ? `Summary: ${packet.summary}` : null,
    packet.branchTarget ? `Branch target: ${packet.branchTarget}` : null,
    packet.dependencyLabels.length > 0 ? `Dependencies: ${packet.dependencyLabels.join(', ')}` : null,
    dependencySections.length > 0 ? 'Dependency handoff context:' : null,
    ...dependencySections,
    priorAttemptLearningSections.length > 0 ? 'Prior attempt learnings:' : null,
    ...priorAttemptLearningSections,
    ...fileSizeSections,
    ...preservationSections,
    'Files in this repository follow an 800-line maximum. If your implementation would push a file past this threshold, extract code into focused modules first, then implement your changes. Files with explicit waivers are exempt from this rule.',
    ...buildPacketSelfReviewInstructions(baseBranch),
    'CRITICAL: Before reporting completion, you MUST commit all changes: run `git add -A && git commit -m "<descriptive message>"`. Uncommitted changes will be lost when the worktree is cleaned up.',
    'Stay within this packet scope. Surface blockers, review handoffs, and required operator decisions explicitly.',
  ].filter((value): value is string => Boolean(value)).join('\n');
}

function createLaneBinding(packet: OrchestratorPacket, laneId: string, sessionKey?: string | null): OrchestratorLaneBinding {
  return {
    tileId: '',
    tabId: '',
    repoPath: packet.workspaceTargetPath,
    worktreePath: null,
    runtime: packet.runtime,
    laneId,
    sessionKey: sessionKey ?? null,
    lastHeartbeatAt: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'dispatch_started',
  };
}

interface DispatchResult {
  kind: 'launched' | 'awaiting_review';
  laneId: string | null;
  sessionKey: string | null;
  lane?: OrchestratorLaneBinding | null;
}

interface LaunchDispatchResult {
  laneId: string;
  sessionKey: string | null;
}

interface RecoveryDispatchContext {
  lane: OrchestratorLaneBinding | null;
  worktreePath: string | null;
}

function isDispatchReadyStatus(packet: OrchestratorPacket) {
  return packet.status === 'queued' || packet.status === 'recovering';
}

async function hasUncommittedWorktreeChanges(worktreePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim().length > 0;
}

async function autoCommitRecoveryWorktree(worktreePath: string): Promise<void> {
  await execFileAsync('git', ['add', '-A'], {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
  await execFileAsync('git', ['commit', '-m', SESSION_RECOVERY_COMMIT_MESSAGE], {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function dispatchOrRecoverPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
  recoveryContext?: RecoveryDispatchContext | null,
): Promise<DispatchResult> {
  if (packet.status === 'recovering' && recoveryContext?.worktreePath) {
    const hasUncommittedChanges = await hasUncommittedWorktreeChanges(recoveryContext.worktreePath);
    if (hasUncommittedChanges) {
      await autoCommitRecoveryWorktree(recoveryContext.worktreePath);

      if (recoveryContext.lane?.laneId) {
        const reviewResult = await dispatchLaneCommand({
          verb: 'request_review',
          laneId: recoveryContext.lane.laneId,
          actor: 'orchestrator',
        });
        if (!reviewResult.ok) {
          throw new Error(reviewResult.note || 'Unable to request review after session recovery.');
        }
      }

      return {
        kind: 'awaiting_review',
        laneId: recoveryContext.lane?.laneId ?? null,
        sessionKey: null,
        lane: recoveryContext.lane
          ? {
              ...recoveryContext.lane,
              sessionKey: null,
            }
          : null,
      };
    }
  }

  const launchResult = await dispatchPacket(packet, allPackets);
  return {
    kind: 'launched',
    laneId: launchResult.laneId,
    sessionKey: launchResult.sessionKey,
  };
}

async function dispatchPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): Promise<LaunchDispatchResult> {
  const laneResult = await dispatchLaneCommand({
    verb: 'open_lane',
    packetId: packet.id,
    repoPath: packet.workspaceTargetPath!,
    branch: packet.branchTarget,
    runtime: packet.runtime,
    label: packet.title,
    actor: 'orchestrator',
  });

  if (!laneResult.ok || !laneResult.laneId) {
    throw new Error(laneResult.note || 'Unable to open lane.');
  }

  const launchResult = await dispatchLaneCommand({
    verb: 'launch_session',
    laneId: laneResult.laneId,
    prompt: await buildPacketPrompt(
      packet,
      allPackets,
      laneResult.lane?.baseBranch ?? 'main',
      laneResult.lane?.worktreePath ?? null,
    ),
    actor: 'orchestrator',
  });

  if (!launchResult.ok) {
    throw new Error(launchResult.note || 'Unable to launch session.');
  }

  return {
    laneId: laneResult.laneId,
    sessionKey: launchResult.lane?.sessionKey ?? null,
  };
}

/**
 * Check if a packet can be dispatched.
 * Returns null if dispatchable, or a string reason if blocked.
 */
export function getDispatchBlocker(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): string | null {
  const candidate = packet.status === 'recovering' ? clearStaleLaneBinding(packet) : packet;

  if (candidate.queueState !== 'queued') {
    return 'Not queued';
  }
  if (candidate.status === 'failed') {
    return 'Failed — max recovery attempts exceeded';
  }
  if (!isDispatchReadyStatus(candidate)) {
    return `Status is ${candidate.status}`;
  }
  // #455 — Block dispatch if recovery limit exceeded
  if (candidate.status === 'recovering' && (candidate.recoveryCount ?? 0) >= MAX_RECOVERY_DISPATCHES) {
    return `Recovery limit exceeded (${candidate.recoveryCount}/${MAX_RECOVERY_DISPATCHES})`;
  }
  const dependency = packetReleaseBlockedBy(candidate, allPackets);
  if (dependency) {
    return `Blocked by ${dependency.id}`;
  }
  if (!candidate.workspaceTargetPath) {
    return 'No workspace target';
  }
  if (candidate.lane?.laneId || candidate.lane?.sessionKey || (candidate.lane?.tileId && candidate.lane?.tabId)) {
    // Allow retry if the lane's last event was a launch failure
    const lastEvent = candidate.lane?.lastEventLabel ?? '';
    if (lastEvent === 'launch_error' || lastEvent === 'launch_failed') {
      // Clear the stale binding so dispatchPacket can re-open/re-launch
    } else {
      return 'Already dispatched';
    }
  }
  return null;
}

/**
 * Run one dispatch tick. For each queued packet with no blockers and no lane binding,
 * dispatch via the lane command bus.
 * Returns the updated mission state.
 */
export async function runDispatchTick(
  state: OrchestratorMissionState,
): Promise<OrchestratorMissionState> {
  let nextState = normalizeOrchestratorMissionState(state);
  const recoveryContextByPacketId = new Map(
    nextState.packets.flatMap((packet) => (
      packet.status === 'recovering'
        ? [[packet.id, {
            lane: packet.lane ?? null,
            worktreePath: packet.lane?.repoPath ?? null,
          }] as const]
        : []
    )),
  );

  const dispatchablePackets = getDispatchableWave(nextState.packets)
    .map((packet) => ({
      packet,
      recoveryContext: recoveryContextByPacketId.get(packet.id) ?? null,
    }))
    .filter(({ packet }) => {
      if (getDispatchBlocker(packet, nextState.packets) !== null) {
        return false;
      }
      // #455 — Recovery cooldown: skip packets that were recovered too recently
      if (packet.status === 'recovering' || recoveryContextByPacketId.has(packet.id)) {
        const lastRecovery = packet.lastRecoveryAt ? Date.now() - new Date(packet.lastRecoveryAt).getTime() : Infinity;
        if (lastRecovery < RECOVERY_COOLDOWN_MS) {
          console.log(`[recovery] Packet ${packet.id} skipped — recovery cooldown (${Math.round(lastRecovery / 1000)}s < ${RECOVERY_COOLDOWN_MS / 1000}s)`);
          return false;
        }
      }
      return true;
    });

  if (dispatchablePackets.length === 0) {
    return nextState;
  }

  for (let index = 0; index < dispatchablePackets.length; index += MAX_PARALLEL_DISPATCHES) {
    const batch = dispatchablePackets.slice(index, index + MAX_PARALLEL_DISPATCHES);
    console.log(`[dag-scheduler] Dispatching ${batch.length} packets in parallel: ${batch.map(({ packet }) => packet.id).join(', ')}`);

    const results = await Promise.allSettled(
      batch.map(({ packet, recoveryContext }) => dispatchOrRecoverPacket(packet, nextState.packets, recoveryContext)),
    );
    nextState = normalizeOrchestratorMissionState({
      ...nextState,
      packets: nextState.packets.map((candidate) => {
        const batchIndex = batch.findIndex(({ packet }) => packet.id === candidate.id);
        if (batchIndex === -1) {
          return candidate;
        }

        const wasRecovering = recoveryContextByPacketId.has(candidate.id);
        const recoveryCount = (candidate.recoveryCount ?? 0) + (wasRecovering ? 1 : 0);
        const recoveryFields = wasRecovering
          ? { recoveryCount, lastRecoveryAt: new Date().toISOString() }
          : {};

        if (wasRecovering) {
          console.log(`[recovery] Packet ${candidate.id} recovery attempt ${recoveryCount}/${MAX_RECOVERY_DISPATCHES}`);
        }

        const result = results[batchIndex];
        if (result.status === 'fulfilled') {
          if (result.value.kind === 'awaiting_review') {
            return {
              ...candidate,
              ...recoveryFields,
              status: 'awaiting_review',
              blockedReason: null,
              lastEventAt: new Date().toISOString(),
              lastEventLabel: 'session_recovery_autocommit',
              lane: result.value.lane ?? candidate.lane ?? null,
            };
          }

          void publishRealtimeMutation({
            mutation: {
              mutationId: `packet-dispatch-${candidate.id}-${Date.now()}`,
              source: 'server',
              action: 'packet-dispatch',
              status: 'completed',
              runtime: candidate.runtime,
              surfaceId: result.value.sessionKey ?? undefined,
              sessionKey: result.value.sessionKey ?? undefined,
              laneId: result.value.laneId ?? undefined,
              packetId: candidate.id,
              packetTitle: candidate.title,
              packetReferenceLabel: candidate.referenceLabel,
              repoPath: candidate.workspaceTargetPath ?? undefined,
              branch: candidate.branchTarget,
              note: `Dispatched ${candidate.referenceLabel} to ${candidate.runtime}`,
              createdAt: new Date().toISOString(),
              settledAt: new Date().toISOString(),
            },
            refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
            sessionKeys: result.value.sessionKey ? [result.value.sessionKey] : [],
            fresh: true,
          });
          return {
            ...candidate,
            ...recoveryFields,
            status: 'launching',
            blockedReason: null,
            lane: createLaneBinding(candidate, result.value.laneId!, result.value.sessionKey),
          };
        }

        const reason = result.reason instanceof Error ? result.reason.message : 'Dispatch failed.';
        console.error(`[dag-scheduler] Failed to dispatch packet ${candidate.id}: ${reason}`);
        return {
          ...candidate,
          ...recoveryFields,
          status: 'blocked',
          blockedReason: reason,
        };
      }),
    });
  }

  return nextState;
}
