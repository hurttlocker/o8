/**
 * GitHub Issue Intake
 *
 * When a GitHub issue is assigned, this module feeds it to the orchestrator
 * (Claude Code) which reads the codebase and generates a scoped plan.
 * The plan surfaces as an approval — operator approves before any agent runs.
 */

import 'server-only';

import type { PlanApprovalContinuation } from '@/lib/approvals/types';
import type { GitHubIssueSnapshot } from '@/lib/github-broker/store';

const LOG_PREFIX = '[github-intake]';
const PLAN_EXTRACT_REGEX = /```json\s*([\s\S]*?)```/;

interface IntakeTask {
  title: string;
  body: string;
}

interface IntakeResult {
  ok: boolean;
  approvalId?: string;
  tasks?: IntakeTask[];
  note: string;
}

function buildPlanningPrompt(issue: GitHubIssueSnapshot, repoFullName: string): string {
  const labels = issue.labels.map((l) => l.name).join(', ') || 'none';
  return [
    `A GitHub issue was just assigned and needs a plan before any agent can work on it.`,
    ``,
    `## Issue #${issue.number}: ${issue.title}`,
    `Repository: ${repoFullName}`,
    `Labels: ${labels}`,
    `Author: ${issue.author?.login ?? 'unknown'}`,
    `Assignees: ${issue.assignees.map((a) => a.login).join(', ') || 'unassigned'}`,
    ``,
    `### Body`,
    issue.body || '(no description)',
    ``,
    `## Instructions`,
    ``,
    `1. Read the relevant codebase areas to understand what this issue requires.`,
    `2. Break the work into 1-4 concrete, scoped tasks that a Codex agent can complete independently in an isolated worktree.`,
    `3. Each task should be small enough for one agent session (under 30 minutes of work).`,
    `4. Include specific file paths, function names, and expected behavior in each task body.`,
    `5. Return your plan as a JSON code block with this exact format:`,
    ``,
    '```json',
    `[`,
    `  { "title": "Short task title", "body": "Detailed description with file paths and expected changes" }`,
    `]`,
    '```',
    ``,
    `Think carefully about decomposition. Prefer fewer, well-scoped tasks over many tiny ones.`,
    `The operator will review your plan before any agent is dispatched.`,
  ].join('\n');
}

function extractTasksFromResponse(text: string): IntakeTask[] | null {
  const match = text.match(PLAN_EXTRACT_REGEX);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter((t: unknown): t is { title: string; body: string } =>
        typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>).title === 'string' && typeof (t as Record<string, unknown>).body === 'string',
      )
      .map((t) => ({ title: t.title, body: t.body }));
  } catch {
    return null;
  }
}

export async function processAssignedIssue(
  issue: GitHubIssueSnapshot,
  repoFullName: string,
  repoPath: string,
): Promise<IntakeResult> {
  console.log(`${LOG_PREFIX} Processing assigned issue #${issue.number}: ${issue.title}`);

  // Check if we already have a packet for this issue
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const state = readOrchestratorControlPlaneState();
  const existingPacket = state.packets.find((p) =>
    p.title.includes(`#${issue.number}`) || p.referenceLabel === `issue-${issue.number}`,
  );
  if (existingPacket) {
    console.log(`${LOG_PREFIX} Issue #${issue.number} already has packet ${existingPacket.id}, skipping`);
    return { ok: true, note: 'Already has a packet.' };
  }

  // Send to orchestrator (Claude Code) for planning
  const { ensureOrchestratorSession, sendToOrchestrator } = await import('@/lib/lane/orchestrator-session');
  const session = ensureOrchestratorSession(repoPath);
  const prompt = buildPlanningPrompt(issue, repoFullName);

  let fullText = '';
  try {
    await sendToOrchestrator(session, prompt, (event) => {
      if (event.type === 'text') {
        fullText += event.text;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Orchestrator failed';
    console.error(`${LOG_PREFIX} Orchestrator planning failed for #${issue.number}: ${message}`);
    return { ok: false, note: `Planning failed: ${message}` };
  }

  const tasks = extractTasksFromResponse(fullText);
  if (!tasks || tasks.length === 0) {
    console.error(`${LOG_PREFIX} Failed to extract tasks from orchestrator response for #${issue.number}`);
    return { ok: false, note: 'Could not parse plan from orchestrator response.' };
  }

  console.log(`${LOG_PREFIX} Generated ${tasks.length} task(s) for issue #${issue.number}`);

  // Create plan approval
  const { createApproval } = await import('@/lib/approvals/store');
  const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');

  const taskSummary = tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n');
  const continuation: PlanApprovalContinuation = {
    kind: 'plan',
    repoPath,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.url,
    tasks,
    runtime: 'codex',
  };

  const approval = createApproval({
    source: 'runtime',
    runtime: 'orchestrator',
    agent: 'github-intake',
    sessionKey: `intake:issue-${issue.number}`,
    title: `Plan: ${issue.title}`,
    description: [
      `Issue #${issue.number} was assigned. The orchestrator generated this plan:`,
      ``,
      taskSummary,
      ``,
      `Approve to dispatch ${tasks.length} Codex agent${tasks.length === 1 ? '' : 's'} in isolated worktrees.`,
    ].join('\n'),
    summary: `${tasks.length} task${tasks.length === 1 ? '' : 's'} planned for #${issue.number}: ${issue.title}`,
    risk: 'medium',
    policyRuleId: 'github_intake_plan',
    metadata: {
      Issue: `#${issue.number}`,
      Repository: repoFullName,
      Tasks: String(tasks.length),
    },
    continuation,
  });

  void publishRealtimeMutation({
    mutation: {
      mutationId: `intake-plan-${approval.id}`,
      source: 'desktop',
      action: 'approve',
      sessionKey: approval.sessionKey,
      surfaceId: approval.sessionKey,
      status: 'pending',
      note: `Plan review: ${issue.title} (${tasks.length} tasks)`,
      createdAt: new Date().toISOString(),
    },
    refreshTargets: ['global', 'mobileInbox'],
    sessionKeys: [approval.sessionKey],
    fresh: true,
  });

  console.log(`${LOG_PREFIX} Created plan approval ${approval.id} for issue #${issue.number}`);
  return { ok: true, approvalId: approval.id, tasks, note: `Plan created with ${tasks.length} task(s).` };
}
