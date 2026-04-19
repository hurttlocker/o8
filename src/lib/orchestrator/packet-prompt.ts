import { renderEdgeCaseSections } from '@/lib/dispatch/edge-case-surfacer';
import { renderReadBudgetSections } from '@/lib/dispatch/read-budget';
import { getTopRulesForPacket, readRepoScopedRules } from '@/lib/dispatch/rules-store';
import { readAttemptLearnings, type AttemptLearning } from '@/lib/orchestrator/attempt-log';
import { readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import { buildPacketSelfReviewInstructions } from '@/lib/orchestrator/self-review';
import type { OrchestratorPacket, PacketContext } from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

import { buildPreservationEnvelope, checkFileSizeThresholds } from './preservation-envelope';

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

function buildLearnedRuleSection(
  packet: OrchestratorPacket,
  packetType: string,
): string | null {
  const repoPath = packet.workspaceTargetPath?.trim();
  if (!repoPath) {
    return null;
  }

  try {
    const seen = new Set<string>();
    const rules = [
      ...readRepoScopedRules(repoPath).map((ruleText) => ({ ruleText, source: 'file' as const })),
      ...getTopRulesForPacket({
        repoPath,
        packetType,
        limit: 5,
      }),
    ].flatMap((rule) => {
      const ruleText = truncateText(rule.ruleText, 200, { normalizeWhitespace: true });
      const normalizedRuleText = ruleText.toLowerCase();
      if (!ruleText || seen.has(normalizedRuleText)) {
        return [];
      }
      seen.add(normalizedRuleText);
      return [`- ${ruleText}`];
    });

    if (rules.length === 0) {
      return null;
    }

    return truncateText([
      'Learned guardrails for this repo (from past reviews):',
      ...rules,
    ].join('\n'), 800);
  } catch (error) {
    console.warn('[learned-rules] fetch failed:', error);
    return null;
  }
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

export async function buildPacketPrompt(
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
  const packetType = packet.title.trim().split(/\s+/)[0]?.toLowerCase() || 'feat';
  const learnedRuleSection = buildLearnedRuleSection(packet, packetType);
  // #535 — Read-before-write scaffolding. When the delegate route or
  // scheduler populated `packet.readBudget`, render it into the prompt so
  // weaker models see the required reads + plan gate up-front. Legacy
  // packets without `readBudget` skip this block entirely.
  const readBudgetSections = renderReadBudgetSections(packet.readBudget);
  // #536 — Edge-case surfacer output. When the surfacer populated
  // `packet.edgeCaseSites`, render them as a grouped "Watch for these"
  // block so weaker models see adjacent risk surfaces up-front.
  const edgeCaseSections = renderEdgeCaseSections(packet.edgeCaseSites);
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
  if (learnedRuleSection) {
    console.log(`[learned-rules] Injected learned guardrails for packet ${packet.id} (${packetType})`);
  }
  if (readBudgetSections.length > 0) {
    console.log(`[read-budget] Injected read-before-write scaffolding for packet ${packet.id} (${packet.readBudget?.requiredReads.length ?? 0} required reads, minToolCalls=${packet.readBudget?.minToolCalls ?? 0})`);
  }
  if (edgeCaseSections.length > 0) {
    console.log(`[edge-case-surfacer] Injected ${packet.edgeCaseSites?.length ?? 0} edge-case sites for packet ${packet.id}`);
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
    ...readBudgetSections,
    ...edgeCaseSections,
    'Files in this repository follow an 800-line maximum. If your implementation would push a file past this threshold, extract code into focused modules first, then implement your changes. Files with explicit waivers are exempt from this rule.',
    learnedRuleSection,
    ...buildPacketSelfReviewInstructions(baseBranch),
    'CRITICAL: Before reporting completion, you MUST commit all changes: run `git add -A && git commit -m "<descriptive message>"`. Uncommitted changes will be lost when the worktree is cleaned up.',
    'Stay within this packet scope. Surface blockers, review handoffs, and required operator decisions explicitly.',
  ].filter((value): value is string => Boolean(value)).join('\n');
}
