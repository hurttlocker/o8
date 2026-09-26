import { DEFAULT_WS_PORT } from '@/lib/panel/api-port';
import { pollCorrelatedMcpApiMutation } from '@/lib/mcp/correlated-mutation';
import { finishSharedCheckoutTeam, inspectSharedCheckoutTeam } from '@/lib/orchestrator/shared-checkout-team';
import { findOwnedLaunchByMutationId, lookupOwnedActiveRunFresh } from '@/lib/runtimes/shared/owned-session-index';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function textResult(message: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value));
}

export function createCortexDelegationHandlers(config: {
  apiBase: string;
  repoPath: string;
  parentThreadId: string;
  fastCapability: string;
  wsToken: string;
}) {
  const handleLaunchAgent = async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) return textResult('prompt is required', true);
      const repoPath = typeof args.repoPath === 'string' && args.repoPath.trim()
        ? args.repoPath.trim() : config.repoPath;
      if (!repoPath) return textResult('repoPath is required (not available from env either)', true);
      const checkoutMode = args.checkoutMode === 'shared' ? 'shared' : 'isolated';
      if (checkoutMode === 'shared' && !config.parentThreadId) {
        return textResult('Fast mode needs a persisted orchestrator chat. Open this conversation in an o8 workspace first.', true);
      }
      if (checkoutMode === 'shared' && repoPath !== config.repoPath) {
        return textResult('Fast mode workers must use this orchestrator workspace checkout.', true);
      }
      const result = await pollCorrelatedMcpApiMutation<Record<string, unknown>>({
        url: `${config.apiBase}/api/orchestrator/delegate`,
        authorization: `Bearer ${config.wsToken}`,
        correlationField: 'clientMutationId',
        body: {
          prompt,
          repoPath,
          taskName: args.taskName || undefined,
          isolate: args.isolate !== false,
          checkoutMode,
          ...(checkoutMode === 'shared' ? {
            parentThreadId: config.parentThreadId,
            fastCapability: config.fastCapability,
            assignedPaths: args.assignedPaths,
          } : {}),
          runtime: args.runtime || undefined,
          model: args.model || undefined,
          workerIntent: args.workerIntent || undefined,
          readOnly: args.readOnly === true,
        },
      });
      if (result.approvalId) return jsonResult({
        ok: false,
        laneId: result.laneId,
        approvalId: result.approvalId,
        note: result.note ?? 'Approval required before this agent can be launched.',
        status: 'awaiting_approval',
      });
      if (!result.ok) return textResult(`Delegation failed: ${result.error ?? result.note ?? 'unknown error'}`, true);

      const surfaceId = result.surfaceId as string;
      try {
        const wsPort = process.env.O8_WS_PORT || process.env.WS_PORT || String(DEFAULT_WS_PORT);
        await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.wsToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            surfaceId,
            repoPath,
            laneId: result.laneId,
            name: (args.taskName as string) || prompt.slice(0, 60),
            prompt,
            ...(result.launchContext ? { launchContext: result.launchContext } : {}),
          }),
          signal: AbortSignal.timeout(3_000),
        });
      } catch {
        // Launch succeeds even when the optional supervisor is unavailable.
      }
      return jsonResult({
        ok: true,
        laneId: result.laneId,
        surfaceId,
        branch: result.branch,
        worktreePath: result.worktreePath ?? null,
        teamId: result.teamId ?? null,
        checkoutMode: result.checkoutMode ?? 'isolated',
        workerRouting: result.workerRouting ?? null,
        note: result.note,
      });
    } catch (error) {
      return textResult(`Failed to launch agent: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  const handleSharedTeamStatus = async (): Promise<ToolResult> => {
    if (!config.repoPath || !config.parentThreadId) {
      return textResult('This tool requires a persisted o8 orchestrator chat.', true);
    }
    try {
      const status = inspectSharedCheckoutTeam({ repoPath: config.repoPath, parentThreadId: config.parentThreadId });
      if (!status) return jsonResult({ team: null, note: 'No Fast workers have been launched from this chat.' });
      const memberOutcomes = await Promise.all(status.team.members.map(async (member) => {
        if (!member.surfaceId) return { taskName: member.taskName, surfaceId: null, outcome: member.state };
        const launch = await findOwnedLaunchByMutationId(member.clientMutationId);
        const active = await lookupOwnedActiveRunFresh(member.surfaceId);
        return {
          taskName: member.taskName,
          surfaceId: member.surfaceId,
          outcome: launch?.surfaceId === member.surfaceId ? launch.outcome : 'unconfirmed',
          activeProcess: active?.pid !== undefined || active?.tmuxSession !== undefined,
        };
      }));
      return jsonResult({ ...status, memberOutcomes });
    } catch (error) {
      return textResult(`Shared team review unavailable: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  const handleFinishSharedTeam = async (args: Record<string, unknown>): Promise<ToolResult> => {
    if (!config.repoPath || !config.parentThreadId) {
      return textResult('This tool requires a persisted o8 orchestrator chat.', true);
    }
    try {
      const reviewSummary = typeof args.reviewSummary === 'string' ? args.reviewSummary.trim() : '';
      const verification = typeof args.verification === 'string' ? args.verification.trim() : '';
      const result = await finishSharedCheckoutTeam({
        repoPath: config.repoPath,
        parentThreadId: config.parentThreadId,
        reviewSummary,
        verification,
      });
      return jsonResult({ ok: true, teamId: result.team.id, reviewedHead: result.reviewedHead,
        committedPaths: result.committedPaths, note: 'Fast team review was archived and checkout ownership was released.' });
    } catch (error) {
      return textResult(`Fast team finish refused: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };

  return { handleLaunchAgent, handleSharedTeamStatus, handleFinishSharedTeam };
}
