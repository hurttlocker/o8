import { isManualThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { parseLocalModel } from '@/lib/codex/local-model';
import type { CodexOrchestratorSession, SendToCodexOrchestratorOptions } from './codex-orchestrator-session';

/** Transport bounds only. This is NOT operator approval or carrier confinement. */
export function assertBoundedRefinementTurn(
  session: CodexOrchestratorSession, options: SendToCodexOrchestratorOptions,
): void {
  if (!options.boundedRefinement) return;
  if (options.permissionMode !== 'plan' || options.toolProfile !== 'propose'
    || options.orchestrationMode !== 'fleet' || options.serviceTier !== 'default'
    || !options.signal || options.attachments?.length || session.threadId || session.proc
    || session.status !== 'ready' || !/^thoughts-harness-[0-9a-f-]{36}$/.test(session.historyThreadId ?? '')
    || typeof options.model !== 'string' || !options.model.trim() || parseLocalModel(options.model)
    || !isManualThinkingEffort(options.thinkingEffort)) {
    throw new Error('Bounded refinement requires exact native pins, plan/propose, a fresh harness session, and an abort signal.');
  }
}

/** Extra defense, not a substitute for a verified isolated proposer carrier. */
export function boundedRefinementFlags(enabled?: true): string[] {
  return enabled ? [
    '--ignore-user-config', '-c', 'approval_policy="never"',
    '-c', 'mcp_servers={}', '-c', 'features.multi_agent=false',
    '-c', 'features.enable_fanout=false', '-c', 'web_search="disabled"',
  ] : [];
}
