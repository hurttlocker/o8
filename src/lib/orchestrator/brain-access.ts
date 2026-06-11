import 'server-only';

/**
 * "Workers use the Brain" resolution (2026-06-11).
 *
 * Decides whether a dispatched worker gets Engineering Brain access — i.e.
 * whether `buildPacketPrompt` injects the `o8 ask` instruction block. Three
 * inputs, strict precedence:
 *
 *   1. packet.useBrain (explicit per-packet override — the dogfood knob)
 *   2. operator default `workersUseBrain` ('off' | 'auto' | 'all')
 *   3. in 'auto': the runtime's capability tier — non-frontier workers get
 *      the Brain so a weaker (or future local) model spends its context on
 *      the task, not on re-deriving repo knowledge a search would cost it.
 *
 * Read-only and cheap (one sync settings-file read, memoized upstream by the
 * OS page cache) — safe to call once per dispatch.
 */

import { resolveWorkersUseBrainSync, type WorkersUseBrain } from '@/lib/operator/defaults';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export interface BrainAccessInput {
  runtime: OrchestratorRuntime;
  useBrain?: boolean;
}

/** Pure core — exported for tests; pass the mode explicitly. */
export function resolveBrainEnabledWith(packet: BrainAccessInput, mode: WorkersUseBrain): boolean {
  if (typeof packet.useBrain === 'boolean') return packet.useBrain;
  if (mode === 'all') return true;
  if (mode === 'off') return false;
  return ORCHESTRATOR_RUNTIMES[packet.runtime]?.tier !== 'frontier';
}

/** Production entry: reads the operator default, then resolves. */
export function resolvePacketBrainEnabled(packet: BrainAccessInput): boolean {
  return resolveBrainEnabledWith(packet, resolveWorkersUseBrainSync());
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
