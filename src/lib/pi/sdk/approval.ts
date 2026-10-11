import { setTimeout as sleep } from 'node:timers/promises';
import type { PiApproval } from './tools';

/** Use the existing approval inbox. No worker-provided approval or bypass flag. */
export function createPiApproval(sessionKey: string, root: string): PiApproval {
  return async (call, signal) => {
    signal.throwIfAborted();
    const { createApproval, getApproval } = await import('@/lib/approvals/store');
    const { resolveApproval } = await import('@/lib/approvals/resolution');
    const command = call.name === 'run_command' ? String(call.args.command) : undefined;
    const approval = createApproval({ source: 'runtime', runtime: 'pi', agent: 'o8 Pi prototype', sessionKey,
      ...(command !== undefined ? {
        title: 'Run a command', summary: command, command, risk: call.risk ?? 'medium', policyRuleId: call.policyRuleId,
        description: 'Approve this exact command. It runs at the workspace root with no credentials in its environment, a time limit and an output limit.',
      } : {
        title: `Write ${String(call.args.path)}`, summary: `Write ${String(call.args.path)}`, risk: 'medium' as const,
        description: 'Approve this exact file content.',
        diff: { path: String(call.args.path), before: call.before, after: String(call.args.content) },
      }),
      toolName: call.name, args: call.args, editable: false,
      metadata: { RepoPath: root, Session: sessionKey } });
    try {
      const expires = Date.now() + 60_000;
      while (Date.now() < expires) {
        signal.throwIfAborted();
        const current = getApproval(approval.id);
        if (!current || current.status !== 'pending') return current?.status === 'approved';
        await sleep(100, undefined, { signal });
      }
      return false;
    } finally {
      if (getApproval(approval.id)?.status === 'pending') {
        resolveApproval(approval.id, 'reject', 'system', 'Prototype approval expired or run stopped');
      }
    }
  };
}
