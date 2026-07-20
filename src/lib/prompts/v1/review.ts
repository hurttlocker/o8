export interface BlindSecondPassPromptInputV1 {
  laneLabel: string;
  branch: string;
  packetId?: string | null;
  diffSummary: string;
  cwd: string;
  highRiskReasons: string[];
}

export function buildBlindSecondPassPromptV1(input: BlindSecondPassPromptInputV1): string {
  const reasons = input.highRiskReasons.length > 0
    ? input.highRiskReasons.map((reason) => `- ${reason}`).join('\n')
    : '- high-risk classification returned no structured reason';
  return [
    `You are the blind, independent second-pass reviewer for lane "${input.laneLabel}" (branch: ${input.branch}).`,
    'Do not rely on any prior review, prior verdict, approval card, summary, or finding. Evaluate only the diff and protocol below.',
    '',
    `## High-risk reasons\n${reasons}`,
    '',
    input.diffSummary,
    '',
    '## Required verification protocol',
    `Worktree: ${input.cwd}`,
    input.packetId ? `Packet: ${input.packetId}` : null,
    'SCOPE traces: for every changed file that writes or mutates state, cite `SCOPE: <file:line> partition=<repo|tenant|user|project|lane|packet|scope|slug|id|NONE>` and confirm the single intended destination.',
    'GUARD traces: for every new guard, condition, or early return, cite `GUARD: <file:line> fires-from=<file:line|INERT>`.',
    'COVERAGE checklist: enumerate each packet sub-requirement as `[x] <sub-requirement> - evidence <file:line|command output>` or `[ ] <sub-requirement> - gap <reason>`.',
    'EXECUTION-PATH TRACE: trace the actual call path the change runs under, not the one its name implies.',
    'You may agree only if every guard is live, every write is partitioned correctly, every sub-requirement is covered, and the execution path reaches the changed code.',
    '',
    'Do NOT call submit_review. Do NOT call lane_command. Do not stamp or merge anything yourself.',
    'End your output with EXACTLY one final line:',
    'SECOND_PASS_VERDICT: agree',
    'OR',
    'SECOND_PASS_VERDICT: disagree - <file:line> <reason>',
  ].filter((value): value is string => value !== null).join('\n');
}

export interface AutoReviewScreenshotV1 {
  path: string;
  width?: number | null;
  height?: number | null;
  mimeType?: string | null;
  capturedAt?: string | null;
}

export interface AutoReviewPromptInputV1 {
  lane: {
    id: string;
    label: string;
    branch: string;
    packetId?: string | null;
  };
  depth: 'fast-track' | 'standard' | 'deep-dive';
  worktreePath: string;
  diffSummary: string;
  selfReviewSection: string;
  deviationsEntries: string[];
  mergeGateSection?: string | null;
  mechanicalChecksSummary?: string | null;
  reviewScreenshot?: AutoReviewScreenshotV1 | null;
  adversarialReviewProtocol?: string | null;
}

export function buildAutoReviewPromptV1(input: AutoReviewPromptInputV1): string {
  const depthGuidance = input.depth === 'deep-dive'
    ? 'This lane has low-confidence or missing self-review context. Perform a deep-dive review and challenge assumptions, edge cases, and missing validation.'
    : 'This lane reports medium-confidence self-review. Do a normal review with independent verification of the claimed changes.';
  // #1490 — surface the worker's self-reported departures to the reviewer.
  const deviationsSection = input.deviationsEntries.length > 0
    ? [
        '## Worker deviations from brief',
        '',
        'The worker logged these departures from the plan (implementation-notes.md → ## Deviations). Verify each is the conservative call the brief asked for, and factor them into your verdict:',
        ...input.deviationsEntries.map((entry) => `- ${entry}`),
      ].join('\n')
    : '## Worker deviations from brief\n\nNo deviations reported by the worker.';
  const reviewScreenshotMetadata = input.reviewScreenshot
    ? [
        typeof input.reviewScreenshot.width === 'number' && input.reviewScreenshot.width > 0
          && typeof input.reviewScreenshot.height === 'number' && input.reviewScreenshot.height > 0
          ? `${input.reviewScreenshot.width}x${input.reviewScreenshot.height}`
          : null,
        input.reviewScreenshot.mimeType ?? null,
        input.reviewScreenshot.capturedAt ? `captured ${input.reviewScreenshot.capturedAt}` : null,
      ].filter((value): value is string => Boolean(value)).join(' • ')
    : '';
  const requiredTraceFormat = [
    '## Required verification traces',
    '',
    'Before any verdict, recommendation, or submit_review call, emit a completed trace block in this exact format:',
    `Worktree: ${input.worktreePath}`,
    input.lane.packetId ? `Packet: ${input.lane.packetId}` : null,
    '',
    'SCOPE traces - required for every changed file that writes or mutates state:',
    '`SCOPE: <file:line> partition=<repo|tenant|user|project|lane|packet|scope|slug|id|NONE>`',
    'Then state the SINGLE intended destination and confirm the diff writes there and ONLY there. Flag output written to the wrong location or duplicated across locations.',
    '',
    'GUARD traces - required for every new guard, condition, or early return:',
    '`GUARD: <file:line> fires-from=<file:line|INERT>`',
    '',
    'COVERAGE checklist - enumerate EACH sub-requirement from the packet scope:',
    '`COVERAGE:`',
    '`[x] <sub-requirement> - evidence <file:line|command output>`',
    '`[ ] <sub-requirement> - gap <reason>`',
    '',
    'Hard approval rule: You may NOT approve if any guard is INERT, any write has partition=NONE, or any COVERAGE box is unchecked. Request changes instead.',
    'To clear an intentional global write, cite the file:line that proves the global destination is correct.',
    'Where the change has observable output (a file written, a command stdout, a function return), PREFER to run it in the worktree and inspect the ACTUAL output over reasoning about the diff.',
  ].filter((value): value is string => value !== null).join('\n');

  return [
    `An agent has completed work on lane "${input.lane.label}" (branch: ${input.lane.branch}).`,
    '',
    depthGuidance,
    '',
    'Review the changes and provide your verdict. Your review summary will be shown',
    'to the operator on their approval card — they don\'t read code, so your summary',
    'IS their understanding of what happened.',
    '',
    input.mergeGateSection,
    input.mergeGateSection ? '' : null,
    input.mechanicalChecksSummary || null,
    input.mechanicalChecksSummary ? '' : null,
    input.selfReviewSection,
    '',
    deviationsSection,
    '',
    input.reviewScreenshot ? '## Attached review screenshot' : null,
    input.reviewScreenshot ? 'A screenshot was auto-captured when this lane entered review. Inspect the image file directly at native resolution instead of asking for a reduced copy.' : null,
    input.reviewScreenshot ? `Image path: ${input.reviewScreenshot.path}` : null,
    reviewScreenshotMetadata ? `Image metadata: ${reviewScreenshotMetadata}` : null,
    input.reviewScreenshot ? '' : null,
    input.diffSummary,
    '',
    requiredTraceFormat,
    '',
    input.adversarialReviewProtocol || null,
    input.adversarialReviewProtocol ? '' : null,
    '## Your review should include:',
    '1. What was changed (1-2 sentences)',
    '2. The Required verification traces above, completed before the verdict',
    '3. EXECUTION-PATH TRACE — trace the actual call path the change runs under, not the one its name implies.',
    input.mergeGateSection ? '4. Address each merge gate violation — these are enforcement-level findings' : null,
    input.mechanicalChecksSummary ? `${input.mergeGateSection ? '5' : '4'}. Address each mechanical check finding — confirm or dismiss` : null,
    `${input.mergeGateSection && input.mechanicalChecksSummary ? '6' : input.mergeGateSection || input.mechanicalChecksSummary ? '5' : '4'}. Your recommendation: approve or request changes`,
    '',
    'After reviewing, FIRST record your verdict by calling submit_review with',
    'approved=true only if all required traces clear; otherwise call it with approved=false and findings. This writes the durable',
    'review record that authorizes merge/PR for the current HEAD. THEN call',
    `lane_command with verb "merge" (or "create_pr") for lane "${input.lane.id}".`,
    'A merge or PR with no recorded approved review will surface an operator',
    'approval card instead of auto-continuing.',
  ].filter((value): value is string => value !== null && value !== undefined).join('\n');
}
