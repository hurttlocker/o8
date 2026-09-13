/**
 * Composer modes (Cursor-parity mission, Q 2026-07-17, v2 ruling) — the "+"
 * switcher carries the agent's operating mode so the model picker stays purely
 * about models and reasoning effort stays independent.
 *
 * The active mode shows as a chip beside the "+" trigger and persists across
 * sends until switched.
 */

import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import { composeComposerWireMessage } from '@/lib/orchestrator/composer-wire';
import {
  COMPOSER_SELECTOR_MODES,
  composerSelectorModeSpec,
  resolveComposerSelectorExecutionMode,
  type ComposerSelectorMode,
  type ComposerSelectorModeSpec,
} from './composer-selector/state';

export type ComposerMode = ComposerSelectorMode;
export type ComposerModeSpec = ComposerSelectorModeSpec;
export const COMPOSER_MODES: readonly ComposerModeSpec[] = COMPOSER_SELECTOR_MODES;

export function composerModeSpec(mode: ComposerMode): ComposerModeSpec {
  return composerSelectorModeSpec(mode);
}

export function resolveComposerExecutionMode(
  mode: ComposerMode,
  forceSingle: boolean,
): OrchestratorExecutionMode {
  if (forceSingle) return 'single';
  return resolveComposerSelectorExecutionMode(mode);
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
  forceSingle: boolean,
) {
  const orchestrationMode = resolveComposerExecutionMode(mode, forceSingle);
  return { ...composeComposerModeMessage(message, mode), orchestrationMode };
}
