import { dirname } from 'node:path';
import { dispatch as dispatchLaneCommand } from '@/lib/lane/commands';
import { getDispatchableWave } from '@/lib/orchestrator/dag';
import { readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { getAllCached, type FileSkeleton } from '@/lib/skeleton';
import { normalizeOrchestratorMissionState, packetReleaseBlockedBy } from '@/lib/orchestrator/store';
import type { OrchestratorLaneBinding, OrchestratorMissionState, OrchestratorPacket, PacketContext } from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

export const MAX_PARALLEL_DISPATCHES = 4;
export const FILE_SIZE_BLOCK_THRESHOLD_LINES = 600;
const FILE_SIZE_WARNING_BUFFER_LINES = 100;
const FILE_SIZE_WARNING_THRESHOLD_LINES = FILE_SIZE_BLOCK_THRESHOLD_LINES - FILE_SIZE_WARNING_BUFFER_LINES;
const MAX_THRESHOLD_GUIDANCE_FILES = 6;
const PATH_TEXT_CHAR_PATTERN = /[A-Za-z0-9._/-]/;

/**
 * Files explicitly allowed to exceed the 600-line threshold.
 * These are layout orchestrators, multiplexers, or other files whose
 * size is inherent to their role (wiring many hooks/components together).
 * Relative paths from repo root, forward-slash separated.
 */
const FILE_SIZE_WAIVERS = new Set([
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

async function buildPacketPrompt(packet: OrchestratorPacket, allPackets: OrchestratorPacket[]) {
  const dependencySections = await buildDependencyContextSections(packet, allPackets);
  const fileSizeSections = checkFileSizeThresholds(packet);
  if (dependencySections.length > 0) {
    console.log(`[context-relay] Injected dependency context for packet ${packet.id}`);
  }
  if (fileSizeSections.length > 0) {
    console.log(`[dispatch] Injected file size governance guidance for packet ${packet.id}`);
  }

  return [
    `Packet: ${packet.title}`,
    packet.summary ? `Summary: ${packet.summary}` : null,
    packet.branchTarget ? `Branch target: ${packet.branchTarget}` : null,
    packet.dependencyLabels.length > 0 ? `Dependencies: ${packet.dependencyLabels.join(', ')}` : null,
    dependencySections.length > 0 ? 'Dependency handoff context:' : null,
    ...dependencySections,
    ...fileSizeSections,
    'Stay within this packet scope. Surface blockers, review handoffs, and required operator decisions explicitly.',
  ].filter((value): value is string => Boolean(value)).join('\n');
}

function createLaneBinding(packet: OrchestratorPacket, laneId: string, sessionKey?: string | null): OrchestratorLaneBinding {
  return {
    tileId: '',
    tabId: '',
    repoPath: packet.workspaceTargetPath,
    runtime: packet.runtime,
    laneId,
    sessionKey: sessionKey ?? null,
    lastHeartbeatAt: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'dispatch_started',
  };
}

interface DispatchResult {
  laneId: string;
  sessionKey: string | null;
}

async function dispatchPacket(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): Promise<DispatchResult> {
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
    prompt: await buildPacketPrompt(packet, allPackets),
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
  if (packet.queueState !== 'queued') {
    return 'Not queued';
  }
  if (packet.status !== 'queued') {
    return `Status is ${packet.status}`;
  }
  const dependency = packetReleaseBlockedBy(packet, allPackets);
  if (dependency) {
    return `Blocked by ${dependency.id}`;
  }
  if (!packet.workspaceTargetPath) {
    return 'No workspace target';
  }
  if (packet.lane?.laneId || packet.lane?.sessionKey || (packet.lane?.tileId && packet.lane?.tabId)) {
    // Allow retry if the lane's last event was a launch failure
    const lastEvent = packet.lane?.lastEventLabel ?? '';
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

  const dispatchablePackets = getDispatchableWave(nextState.packets)
    .filter((packet) => getDispatchBlocker(packet, nextState.packets) === null);

  if (dispatchablePackets.length === 0) {
    return nextState;
  }

  for (let index = 0; index < dispatchablePackets.length; index += MAX_PARALLEL_DISPATCHES) {
    const batch = dispatchablePackets.slice(index, index + MAX_PARALLEL_DISPATCHES);
    console.log(`[dag-scheduler] Dispatching ${batch.length} packets in parallel: ${batch.map((packet) => packet.id).join(', ')}`);

    const results = await Promise.allSettled(batch.map((packet) => dispatchPacket(packet, nextState.packets)));
    nextState = normalizeOrchestratorMissionState({
      ...nextState,
      packets: nextState.packets.map((candidate) => {
        const batchIndex = batch.findIndex((packet) => packet.id === candidate.id);
        if (batchIndex === -1) {
          return candidate;
        }

        const result = results[batchIndex];
        if (result.status === 'fulfilled') {
          void publishRealtimeMutation({
            mutation: {
              mutationId: `packet-dispatch-${candidate.id}-${Date.now()}`,
              source: 'server',
              action: 'packet-dispatch',
              status: 'completed',
              runtime: candidate.runtime,
              surfaceId: result.value.sessionKey ?? undefined,
              sessionKey: result.value.sessionKey ?? undefined,
              laneId: result.value.laneId,
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
            status: 'launching',
            blockedReason: null,
            lane: createLaneBinding(candidate, result.value.laneId, result.value.sessionKey),
          };
        }

        const reason = result.reason instanceof Error ? result.reason.message : 'Dispatch failed.';
        console.error(`[dag-scheduler] Failed to dispatch packet ${candidate.id}: ${reason}`);
        return {
          ...candidate,
          status: 'blocked',
          blockedReason: reason,
        };
      }),
    });
  }

  return nextState;
}
