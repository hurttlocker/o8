import { museRecord } from './protocol';
import type { requestMuseApproval } from './approval';

/** Each native requirement gets one fresh decision; superseded decisions cannot execute. */
export function createMuseApprovalStages(options: {
  approve: typeof requestMuseApproval;
  context: { sessionKey: string; repoPath: string; signal?: AbortSignal };
  decide: (params: Record<string, unknown>) => Promise<unknown>;
  turnId: () => string | undefined;
  fail: () => void;
}) {
  interface Stage { params: Record<string, unknown>; key: string; controller: AbortController; deciding?: boolean; queued?: Record<string, unknown> }
  const stages = new Map<string, Stage>();
  const seen = new Set<string>();
  const resolved = new Set<string>();
  function retire(id: string) { stages.get(id)?.controller.abort(); stages.delete(id); }
  const manager = {
    accept(method: string, incoming: Record<string, unknown>) {
      if (typeof incoming.approvalId !== 'string') return;
      const id = incoming.approvalId;
      if (method === 'approval/resolved' || museRecord(incoming.change).kind === 'alreadyTerminal') { resolved.add(id); retire(id); return; }
      if (resolved.has(id)) return;
      const previous = stages.get(id);
      if (method === 'approval/updated' && !previous) return;
      if (method === 'approval/updated' && previous?.deciding) { previous.queued = incoming; return; }
      if (method === 'approval/requested' && incoming.turnId !== options.turnId()) return;
      const params: Record<string, unknown> = { ...previous?.params, ...incoming, protectedWrite: previous?.params.protectedWrite === true || incoming.protectedWrite === true };
      const key = `${id}:${JSON.stringify(params.currentRequirementId)}`;
      if (seen.has(key)) return;
      retire(id);
      seen.add(key);
      const controller = new AbortController();
      const stage: Stage = { params, key, controller };
      stages.set(id, stage);
      const abort = () => controller.abort();
      options.context.signal?.addEventListener('abort', abort, { once: true });
      if (options.context.signal?.aborted) abort();
      void (async () => {
        const choiceId = await options.approve(params, { ...options.context, signal: controller.signal });
        if (controller.signal.aborted || stages.get(id) !== stage) return;
        if (!choiceId) { options.fail(); return; }
        stage.deciding = true;
        const acknowledgement = museRecord(await options.decide({ approvalId: id, requirementId: params.currentRequirementId, choiceId }));
        if (controller.signal.aborted || stages.get(id) !== stage) return;
        stage.deciding = false;
        if (acknowledgement.terminal === true) { resolved.add(id); retire(id); }
        else if (stage.queued) manager.accept('approval/updated', stage.queued);
      })().catch(options.fail).finally(() => options.context.signal?.removeEventListener('abort', abort));
    },
    clear() { for (const id of stages.keys()) retire(id); seen.clear(); resolved.clear(); },
  };
  return manager;
}
