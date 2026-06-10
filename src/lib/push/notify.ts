/**
 * Server-side push fan-out helpers.
 *
 * Call these from anywhere we already detect an "operator-noteworthy" event
 * (approval created, agent finished, merge conflict, etc.). They:
 *   - load every subscription
 *   - fire encrypted Web Push (or webhook) requests in parallel
 *   - prune dead subscriptions on 404/410
 *   - silently no-op when no subscriptions are registered
 *
 * Issue: https://github.com/hurttlocker/o8/issues/639
 */

import 'server-only';
import { listPushSubscriptions } from './store';
import { sendPushToSubscription, type PushPayload, type SendResult } from './send';

const ENABLED = process.env.O8_PUSH_NOTIFICATIONS_ENABLED !== '0';

export async function notifyAll(payload: PushPayload): Promise<SendResult[]> {
  if (!ENABLED) return [];

  const subs = listPushSubscriptions();
  if (subs.length === 0) return [];

  const results = await Promise.allSettled(subs.map((sub) => sendPushToSubscription(sub, payload)));
  return results.map((r, idx) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      endpoint: subs[idx].endpoint,
      ok: false,
      status: 0,
      reason: r.reason instanceof Error ? r.reason.message : 'unknown',
    };
  });
}

/**
 * Fire-and-forget wrapper. Use from non-async call sites where we want to
 * trigger the fan-out without blocking the originating event handler.
 */
export function notifyAllInBackground(payload: PushPayload): void {
  void notifyAll(payload).catch((error) => {
    console.warn('[push-notify] background notify failed', error);
  });
}

// ── Pre-baked payload helpers for the four trigger points (issue spec) ──

export function notifyApprovalCreated(opts: {
  approvalId: string;
  title: string;
  risk?: string;
}): void {
  notifyAllInBackground({
    title: 'Approval needed',
    body: opts.title,
    tag: `approval-${opts.approvalId}`,
    url: '/mobile?view=approvals',
    data: { approvalId: opts.approvalId, risk: opts.risk, kind: 'approval' },
  });
}

export function notifyAgentFinished(opts: {
  sessionName: string;
  state: 'completed' | 'failed' | 'killed' | 'stalled';
  exitCode?: number;
}): void {
  const labelByState: Record<typeof opts.state, string> = {
    completed: 'finished',
    failed: 'failed',
    killed: 'was stopped',
    stalled: 'is stalled',
  };
  notifyAllInBackground({
    title: `${opts.sessionName} ${labelByState[opts.state]}`,
    body: opts.exitCode !== undefined ? `exit ${opts.exitCode}` : labelByState[opts.state],
    tag: `agent-${opts.sessionName}`,
    url: '/mobile?view=agents',
    data: { sessionName: opts.sessionName, state: opts.state, kind: 'agent' },
  });
}

export function notifyMergeConflict(opts: {
  repo: string;
  fileCount: number;
}): void {
  notifyAllInBackground({
    title: 'Merge conflict',
    body: `${opts.fileCount} file${opts.fileCount === 1 ? '' : 's'} on ${opts.repo} need attention`,
    tag: `conflict-${opts.repo}`,
    url: '/mobile?view=approvals',
    data: { repo: opts.repo, fileCount: opts.fileCount, kind: 'conflict' },
  });
}

export function notifyOrchestratorReady(opts: {
  threadId?: string;
  summary?: string;
}): void {
  notifyAllInBackground({
    title: 'Orchestrator ready',
    body: opts.summary ?? 'Awaiting your input',
    tag: opts.threadId ? `orchestrator-${opts.threadId}` : 'orchestrator',
    url: '/mobile?view=orchestrator',
    data: { threadId: opts.threadId, kind: 'orchestrator' },
  });
}
