/**
 * Fable orchestrator backend — a thin delegate over the UNMODIFIED
 * `orchestrator-session.ts` REPL, like `claude.ts`, but it forces the
 * `claude-fable-5` model and the `'fable'` ToolProfile onto every turn.
 *
 * Placing `model` / `toolProfile` AFTER the `...options` spread is load-bearing:
 * it overrides the Opus default (`DEFAULT_ORCHESTRATOR_MODEL`, orchestrator-
 * session.ts:505) that `sendToOrchestrator` would otherwise apply, and locks the
 * turn to the Fable tool surface + native-tool lockout regardless of caller
 * options.
 *
 * Slice 1: subscription-shaped REPL spawn, Claude's native read/write tools
 * stripped (the token lever, Layer B — see `../fable-profile.ts`), operator's BYO
 * `ANTHROPIC_API_KEY` injected into the Fable proc's env only. Model + key resolve
 * via `fable-config.ts`.
 */

import { prewarmHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { prewarmSonnetCli } from '@/lib/cortex/qa/llm/sonnet-adapter';
import {
  ensureOrchestratorSession,
  getOrchestratorSession,
  sendToOrchestrator,
} from '@/lib/lane/orchestrator-session';
import { resolveFableConfig } from './fable-config';
import type { OrchestratorBackend } from './types';

export const fableBackend: OrchestratorBackend = {
  id: 'fable',
  label: 'Fable',
  peekSession(repoPath, _agent, threadId) {
    const session = getOrchestratorSession(repoPath, threadId);
    return session ? { sessionName: session.sessionName, status: session.status } : null;
  },
  ensureSession(repoPath, _agent, threadId) {
    const session = ensureOrchestratorSession(repoPath, threadId);
    return { sessionName: session.sessionName, status: session.status };
  },
  sendTurn(repoPath, message, onEvent, options) {
    // Slice 2 — warm-as-hell Brain. With native reads stripped, `cortex_ask` is
    // Fable's only repo-context path, so the Brain fires on effectively every
    // turn. Heat the warm pool at turn START (classifier Haiku + Sonnet-5
    // compose) so the ask lands on a hot proc. Fire-and-forget; never blocks —
    // and never becomes an unhandled rejection on a cold env (Slice 6 #5).
    void prewarmHaiku().catch(() => {});
    void prewarmSonnetCli().catch(() => {});
    const { model, apiKey } = resolveFableConfig();
    if (!apiKey) {
      // Slice 6 #4 — never a silent billing surprise: with no BYO key the fable
      // proc runs on ambient subscription credentials. Fine while the model is
      // on the sub; loud so the operator knows which pool is paying.
      console.warn('[fable] O8_FABLE_ANTHROPIC_API_KEY unset — this Fable turn bills the ambient subscription pool, not a metered API key.');
    }
    return sendToOrchestrator(
      ensureOrchestratorSession(repoPath, options?.threadId),
      message,
      onEvent,
      // model + toolProfile AFTER ...options so they win over the Opus default
      // (orchestrator-session.ts:505) and any caller-supplied profile.
      {
        ...options,
        model,
        toolProfile: options?.orchestrationMode === 'single' ? 'fable-solo' : 'fable',
      },
    );
  },
};
