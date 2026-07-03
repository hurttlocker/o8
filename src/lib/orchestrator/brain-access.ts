import 'server-only';

/**
 * "Workers use the Brain" resolution (2026-06-11).
 *
 * Decides whether a dispatched worker gets Engineering Brain access — i.e.
 * whether `buildPacketPrompt` injects the `o8 ask` instruction block. Strict
 * precedence:
 *
 *   1. packet.useBrain (explicit per-packet override — the dogfood knob)
 *   2. operator default `workersUseBrain` ('off' | 'auto' | 'all')
 *   3. in 'auto': a METERED active orchestrator (Fable mode, 2026-07-02)
 *      flips the Brain ON for every runtime — under metered economics repo
 *      knowledge must come from the fixed-cost Brain, never flow back through
 *      the per-token orchestrator window. Keyed to the billing class (not the
 *      backend name) so the next metered model inherits the flip.
 *   4. otherwise in 'auto': the runtime's capability tier — non-frontier
 *      workers get the Brain so a weaker (or future local) model spends its
 *      context on the task, not on re-deriving repo knowledge a search would
 *      cost it.
 *
 * Read-only and cheap (one sync settings-file read, memoized upstream by the
 * OS page cache) — safe to call once per dispatch.
 */

import { resolveOrchestratorBackendId } from '@/lib/lane/orchestrator-backends/active-backend';
import { isMeteredOrchestratorBackend } from '@/lib/lane/orchestrator-backends/billing';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { resolveWorkersUseBrainSync, type WorkersUseBrain } from '@/lib/operator/defaults';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export interface BrainAccessInput {
  runtime: OrchestratorRuntime;
  useBrain?: boolean;
}

/** Pure core — exported for tests; pass the mode (and backend) explicitly. */
export function resolveBrainEnabledWith(
  packet: BrainAccessInput,
  mode: WorkersUseBrain,
  orchestratorBackend?: OrchestratorBackendId,
): boolean {
  if (typeof packet.useBrain === 'boolean') return packet.useBrain;
  if (mode === 'all') return true;
  if (mode === 'off') return false;
  if (orchestratorBackend && isMeteredOrchestratorBackend(orchestratorBackend)) return true;
  return ORCHESTRATOR_RUNTIMES[packet.runtime]?.tier !== 'frontier';
}

/**
 * Production entry: reads the operator default + active backend, then resolves.
 *
 * Known approximation (hard-task review, 2026-07-03): the backend here is the
 * OPERATOR-DEFAULT resolution, not the per-request `msg.backend` override a ws
 * turn can carry (e.g. a one-off collide turn while the default is fable, or
 * vice versa). The mismatch only matters when the two differ in billing class,
 * and it errs toward Brain-ON — which is free (subscription pool) and never
 * harms the metered window. Thread the actual turn backend through the
 * dispatch chain if per-turn precision ever matters.
 */
export function resolvePacketBrainEnabled(packet: BrainAccessInput): boolean {
  return resolveBrainEnabledWith(packet, resolveWorkersUseBrainSync(), resolveOrchestratorBackendId());
}

/**
 * The prompt block injected when Brain access is on. Lives here (not in
 * packet-prompt.ts) so the MCP/composer surfaces can echo the same contract.
 */
export const BRAIN_PROMPT_SECTION = [
  'Engineering Brain available: run `o8 ask "<question>"` for instant answers about THIS repo — conventions, directives, past fixes, recent PRs, who-owns-what.',
  'It returns JSON: an `answer` plus `citations` with human-readable titles. Prefer one ask over grepping for conventions or history — it costs seconds and keeps your context for the actual change.',
  'Good asks: `o8 ask "What is the theming rule for surface colors?"` · `o8 ask "Have we fixed a flaky lane reconciliation before?"` · `o8 ask "Which middleware gate covers new API routes?"`',
  'The Brain answers questions about the codebase; writing the code is still your job.',
].join(' ');
