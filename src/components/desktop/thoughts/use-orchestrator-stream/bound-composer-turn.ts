import { contextualTurnMessage } from '../chat-panel/contextual-turn';
import type { OrchestratorSendHandle, OrchestratorSendOptions } from './types';

/** Preserve the governed send seam while allowing an explicitly pinned voice route. */
export function sendBoundComposerTurn(
  send: (message: string, options: OrchestratorSendOptions) => OrchestratorSendHandle | null,
  message: string,
  options: OrchestratorSendOptions,
  context: {
    pickedMode: OrchestratorSendOptions['pickedMode'];
    requestContext?: string;
    handoffMode?: 'handoff' | null;
    ensureSelectedRepoPersisted: (signal: AbortSignal) => Promise<boolean>;
    restoreDraft: () => void;
    resolveOptions: NonNullable<OrchestratorSendOptions['resolveTurnOptions']>;
  },
) {
  return send(message, {
    ...options, pickedMode: context.pickedMode,
    wireMessage: contextualTurnMessage(options.wireMessage ?? message, context.requestContext),
    ...(context.handoffMode ? { handoffMode: context.handoffMode } : {}),
    beforeSend: async signal => {
      const ready = await context.ensureSelectedRepoPersisted(signal);
      if (!ready && !signal.aborted) context.restoreDraft();
      return ready;
    },
    resolveTurnOptions: options.resolveTurnOptions ?? context.resolveOptions,
  });
}
