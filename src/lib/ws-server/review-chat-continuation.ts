import { randomUUID } from 'node:crypto';
import { appendEvent } from '@/lib/lane/registry';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import { sendOrchestratorBackendTurn } from '@/lib/lane/orchestrator-send-entry';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { appendMobileOrchestratorUserMessage, upsertMobileOrchestratorAssistantMessage } from '@/lib/mobile/orchestrator-thread-history';
import type { MobileTurnReceipt } from '@/lib/mobile/types';
import { claimReviewChatContinuation, resolveReviewChatOrigin, type ReviewChatOrigin } from '@/lib/orchestrator/review-continuation-origin';
import type { ReviewContinuationLane } from '@/lib/orchestrator/review-continuation';
import { withSessionRules } from '@/lib/orchestrator/session-rules-prompt';
import { withOrchestratorTurnReceiptContext } from '@/lib/orchestrator/turn-receipt-context';
import { prepareOrchestratorProjectTurn, readPersistedOrchestratorProjectSelection } from '@/lib/ws-server/orchestrator-project-context';

export interface ReviewChatContinuationHooks {
  registerAbort(repoPath: string, origin: ReviewChatOrigin, controller: AbortController): () => void;
  publish(sessionName: string, event: string, data: Record<string, unknown>): void;
}

/** Called by the existing auto queue. A bound turn uses the chat's normal abort key. */
export async function runReviewChatContinuation(
  lane: ReviewContinuationLane,
  expected: ReviewChatOrigin,
  message: string,
  hooks: ReviewChatContinuationHooks,
): Promise<void> {
  const current = resolveReviewChatOrigin(lane);
  if (current.kind !== 'bound' || JSON.stringify(current.origin) !== JSON.stringify(expected)) {
    appendEvent(lane.id, 'update', 'system', { event: 'chat_review_continuation_refused', reason: 'Origin changed while queued.' });
    return;
  }
  const backend = getOrchestratorBackend(expected.backend);
  const controller = new AbortController();
  const release = hooks.registerAbort(lane.repoPath, expected, controller);
  const startedAt = Date.now();
  const assistantMessageId = `assistant-review-${randomUUID()}`;
  let text = '';
  let receipt: MobileTurnReceipt = { leadModel: expected.model, effort: expected.effort,
    mode: expected.mode === 'single' ? 'solo' : expected.mode === 'fusion' ? 'fusion' : 'multitask' };
  const data = { repoPath: lane.repoPath, threadId: expected.threadId, backend: backend.id, model: expected.model, assistantMessageId };
  const persist = (sessionId: string | null) => upsertMobileOrchestratorAssistantMessage({
    tabId: expected.threadId, repoPath: lane.repoPath, messageId: assistantMessageId, content: text,
    backend: backend.id, model: expected.model, receipt, sessionId, timestampMs: startedAt,
  });
  try {
    if (!claimReviewChatContinuation(lane, expected)) return;
    const session = backend.ensureSession(lane.repoPath, undefined, expected.threadId);
    const selection = await readPersistedOrchestratorProjectSelection(expected.threadId);
    const project = await prepareOrchestratorProjectTurn({ message, repoPath: lane.repoPath, persistedProjectId: selection?.projectId });
    const fresh = resolveReviewChatOrigin(lane);
    if (controller.signal.aborted || fresh.kind !== 'bound' || JSON.stringify(fresh.origin) !== JSON.stringify(expected)) return;
    appendMobileOrchestratorUserMessage({ tabId: expected.threadId, repoPath: lane.repoPath, message,
      messageId: `review-user-${assistantMessageId}`, backend: backend.id, timestampMs: startedAt });
    persist(null);
    hooks.publish(session.sessionName, 'status', { ...data, status: 'busy' });
    await sendOrchestratorBackendTurn(backend, lane.repoPath, withOrchestratorTurnReceiptContext({
      message: withSessionRules(project.message, expected.threadId), threadId: expected.threadId, turnId: assistantMessageId,
    }), (event: OrchestratorEvent) => {
      switch (event.type) {
        case 'turn_receipt':
          receipt = { ...receipt, leadModel: event.leadModel, effort: event.effort }; persist(null); break;
        case 'text':
          text += event.text; persist(null);
          hooks.publish(session.sessionName, 'output', { ...data, text: event.text, thinking: false }); break;
        case 'thinking': hooks.publish(session.sessionName, 'output', { ...data, text: event.text, thinking: true }); break;
        case 'tool_use': hooks.publish(session.sessionName, 'tool-use', { ...data, name: event.name, args: event.input, toolUseId: event.id }); break;
        case 'tool_result': hooks.publish(session.sessionName, 'tool-result', { ...data, name: event.name, args: event.input, output: event.output, toolUseId: event.id, isError: event.isError }); break;
        case 'plan': hooks.publish(session.sessionName, 'plan-update', { ...data, turnId: assistantMessageId, explanation: event.explanation, steps: event.steps }); break;
        case 'done': persist(event.sessionId); hooks.publish(session.sessionName, 'status', { ...data, status: controller.signal.aborted ? 'stopped' : 'ready', receipt }); break;
        case 'error': hooks.publish(session.sessionName, 'error', { ...data, error: event.error }); break;
        case 'turn_retry': text = ''; persist(null); break;
        case 'collide_phase': case 'collide_proposal': case 'handoff': break;
      }
    }, { threadId: expected.threadId, model: expected.model, thinkingEffort: expected.effort,
      permissionMode: 'full', signal: controller.signal,
      crashSurvival: { backend: expected.backend as 'codex' | 'claude', threadId: expected.threadId,
        assistantMessageId, assistantStartedAtMs: startedAt, model: expected.model } }, expected.mode);
  } catch (error) {
    hooks.publish(backend.peekSession(lane.repoPath, undefined, expected.threadId)?.sessionName ?? '', controller.signal.aborted ? 'status' : 'error', controller.signal.aborted
      ? { ...data, status: 'stopped' } : { ...data, error: 'The bound review continuation failed. Inspect the originating chat and packet before retrying.' });
    throw error;
  } finally {
    try {
      if (controller.signal.aborted) appendEvent(lane.id, 'update', 'system', { event: 'chat_review_continuation_interrupted', threadId: expected.threadId });
    } finally { release(); }
  }
}
