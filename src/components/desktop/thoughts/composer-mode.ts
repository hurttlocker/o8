/**
 * Composer modes (Cursor-parity mission, Q 2026-07-17, v2 ruling) — the "+"
 * switcher carries the agent's operating mode so the model picker stays purely
 * about models. Three modes, Q's exact semantics:
 *
 * - Solo — the orchestrator does NOT dispatch anything: it works directly in
 *   this session with its own tools.
 * - Multitask — it DOES dispatch: decompose into parallel worker packets in
 *   isolated worktrees.
 * - Mixture of Agents — it multitasks, but PLANS with both frontier models
 *   first (Collide backend: Claude + Codex propose, one synthesizer decides).
 *   The panel flips collide state alongside the directive.
 *
 * The active mode shows as a chip beside the "+" trigger and persists across
 * sends until switched.
 */

import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import {
  COMPOSER_MODE_DIRECTIVES,
  composeComposerWireMessage,
  type ComposerWireMode,
} from '@/lib/orchestrator/composer-wire';

export type ComposerMode = ComposerWireMode;

export interface ComposerModeSpec {
  id: ComposerMode;
  label: string;
  /** Short chip text shown beside the "+" trigger. */
  chip: string;
  sublabel: string;
  placeholder: string;
  /** Directive line prepended to the sent message. Null = no shaping. */
  directive: string | null;
}

export const COMPOSER_MODES: readonly ComposerModeSpec[] = [
  {
    id: 'solo',
    label: 'Solo',
    chip: 'Solo',
    sublabel: 'Works alone — nothing is dispatched',
    placeholder: 'Build solo — no dispatches · / for commands',
    directive: COMPOSER_MODE_DIRECTIVES.solo,
  },
  {
    id: 'multitask',
    label: 'Multitask',
    chip: 'Multitask',
    sublabel: 'Dispatches parallel worker packets in isolated worktrees',
    placeholder: 'Fan out — describe work to parallelize into packets…',
    directive: COMPOSER_MODE_DIRECTIVES.multitask,
  },
  {
    id: 'moa',
    label: 'Mixture of Agents',
    chip: 'MoA',
    sublabel: 'Plans with both frontier models, then dispatches',
    placeholder: 'Mixture of Agents — plan with both frontiers, then fan out…',
    directive: COMPOSER_MODE_DIRECTIVES.moa,
  },
];

export function composerModeSpec(mode: ComposerMode): ComposerModeSpec {
  return COMPOSER_MODES.find((m) => m.id === mode) ?? COMPOSER_MODES[0];
}

export function resolveComposerExecutionMode(
  mode: ComposerMode,
  fusionEnabled: boolean,
  forceSingle: boolean,
): OrchestratorExecutionMode {
  if (forceSingle) return 'single';
  if (fusionEnabled) return 'fusion';
  return mode === 'solo' ? 'single' : 'fleet';
}

/**
 * Keep the operator's text distinct from the model-facing mode directive.
 * Slash commands pass through so the route parser still sees their prefix.
 */
export function composeComposerModeMessage(message: string, mode: ComposerMode): {
  displayMessage: string;
  wireMessage: string;
} {
  return composeComposerWireMessage(message, mode);
}

export function composeComposerTurnMessage(
  message: string,
  mode: ComposerMode,
  fusionEnabled: boolean,
  forceSingle: boolean,
) {
  const orchestrationMode = resolveComposerExecutionMode(mode, fusionEnabled, forceSingle);
  const promptMode = orchestrationMode === 'fusion' && mode === 'solo' ? 'multitask' : mode;
  return { ...composeComposerModeMessage(message, promptMode), orchestrationMode };
}
