import { describe, expect, it } from 'vitest';

import {
  COMPOSER_MODE_DIRECTIVES,
  composeComposerWireMessage,
  isKnownComposerPreambleTitle,
  modelFacingComposerMessage,
  resolveOrchestratorTranscriptMessage,
  stripKnownComposerWirePreamble,
  type ComposerWireMode,
} from './composer-wire';

const MODES: ComposerWireMode[] = ['solo', 'multitask', 'fast', 'moa'];

/** Directives as o8 shipped them before #2153 — still on the wire from old clients. */
const LEGACY_MULTITASK = '[Mode: Multitask] Decompose this into parallel worker packets and dispatch them into isolated worktrees instead of working serially yourself. Review and merge through the gate as they finish.';
const LEGACY_FAST = '[Mode: Fast] Decompose independent work by file ownership. Call `cortex_launch_agent` once per worker in parallel in this turn with `checkoutMode: "shared"` and non-overlapping relative `assignedPaths`. Each worker edits the same current checkout. Tell them not to commit, reset, stash, or switch branches. Track each surface and resolve overlap before accepting edits. Call `cortex_shared_team_status` to inspect all changed and committed paths, review the combined diff and run checks, then make one orchestrator-owned commit of only your team edits. If independent changes block Finish, review their actual diff and explicitly call `cortex_reconcile_shared_team` with the exact status review ID, HEAD and all review paths; never commit or discard someone else’s work to clear the hold. Finally call `cortex_finish_shared_team` with review and verification receipts to release checkout ownership. Never claim a worker was launched without a tool receipt.';
const PRE_RENAME_FAST = '[Mode: Fast] Work in the current checkout. Work directly for small tasks and ordinary replies. Delegate only when the user asks or independent work benefits from workers; choosing Shared alone does not require a launch. Choose suitable enabled runtimes and models for each task. If delegating, divide independent work by file ownership and call `cortex_launch_agent` once per worker with `checkoutMode: "shared"` and non-overlapping relative `assignedPaths`. Each worker edits the same current checkout. Tell them not to commit, reset, stash, or switch branches. Track each surface and resolve overlap before accepting edits. Call `cortex_shared_team_status` to inspect all changed and committed paths, review the combined diff and run checks, then make one orchestrator-owned commit of only your team edits. If independent changes block Finish, review their actual diff and explicitly call `cortex_reconcile_shared_team` with the exact status review ID, HEAD and all review paths; never commit or discard someone else’s work to clear the hold. Finally call `cortex_finish_shared_team` with review and verification receipts to release checkout ownership. Never claim a worker was launched without a tool receipt.';
const LEGACY_MOA = '[Mode: Mixture of Agents] After the proposal round, decompose the work into parallel worker packets and dispatch them into isolated worktrees. Review and merge through the gate as they finish.';

describe('composer mode directives', () => {
  it('names the launch tool in the dispatching modes (#2153)', () => {
    for (const mode of ['multitask', 'moa'] as const) {
      expect(COMPOSER_MODE_DIRECTIVES[mode]).toContain('cortex_launch_agent');
      expect(COMPOSER_MODE_DIRECTIVES[mode]).toMatch(/call it once per packet/i);
    }
  });

  it('keeps Solo a prohibition and never points it at the launch tool', () => {
    expect(COMPOSER_MODE_DIRECTIVES.solo).toContain('do NOT dispatch worker agents');
    expect(COMPOSER_MODE_DIRECTIVES.solo).not.toContain('cortex_launch_agent');
  });

  it('requires scoped shared launches and a single orchestrator review in Shared mode', () => {
    expect(COMPOSER_MODE_DIRECTIVES.fast).toMatch(/^\[Mode: Shared\]/);
    expect(COMPOSER_MODE_DIRECTIVES.fast).toContain('checkoutMode: "shared"');
    expect(COMPOSER_MODE_DIRECTIVES.fast).toContain('assignedPaths');
    expect(COMPOSER_MODE_DIRECTIVES.fast).toContain('Delegate only when the user asks');
    expect(COMPOSER_MODE_DIRECTIVES.fast).toContain('Work directly for small tasks');
    expect(COMPOSER_MODE_DIRECTIVES.fast).not.toContain('in parallel in this turn');
    expect(COMPOSER_MODE_DIRECTIVES.fast).toContain('one orchestrator-owned commit');
  });

  it('keeps every directive prefixed with its [Mode: …] marker', () => {
    expect(COMPOSER_MODE_DIRECTIVES.solo.startsWith('[Mode: Solo]')).toBe(true);
    expect(COMPOSER_MODE_DIRECTIVES.multitask.startsWith('[Mode: Multitask]')).toBe(true);
    expect(COMPOSER_MODE_DIRECTIVES.moa.startsWith('[Mode: Mixture of Agents]')).toBe(true);
  });
});

describe('composeComposerWireMessage', () => {
  it('round-trips the operator text back out of every mode preamble', () => {
    const operatorText = 'Build a three-page static site: home, about, contact';
    for (const mode of MODES) {
      const { displayMessage, wireMessage } = composeComposerWireMessage(operatorText, mode);
      expect(displayMessage).toBe(operatorText);
      expect(wireMessage).toBe(`${COMPOSER_MODE_DIRECTIVES[mode]}\n\n${operatorText}`);
      expect(stripKnownComposerWirePreamble(wireMessage)).toBe(operatorText);
      expect(resolveOrchestratorTranscriptMessage({ message: wireMessage })).toBe(operatorText);
    }
  });

  it('passes slash commands through unshaped', () => {
    expect(composeComposerWireMessage('/chat Explain this diff', 'multitask')).toEqual({
      displayMessage: '/chat Explain this diff',
      wireMessage: '/chat Explain this diff',
    });
  });
});

describe('stripKnownComposerWirePreamble', () => {
  it('still strips the pre-#2153 directives sent by older clients', () => {
    expect(stripKnownComposerWirePreamble(`${LEGACY_FAST}\n\nInspect this`)).toBe('Inspect this');
    expect(stripKnownComposerWirePreamble(`${PRE_RENAME_FAST}\n\nInspect this`)).toBe('Inspect this');
    expect(resolveOrchestratorTranscriptMessage({ message: `${PRE_RENAME_FAST}\n\nInspect this` })).toBe('Inspect this');
    expect(stripKnownComposerWirePreamble(`${LEGACY_MULTITASK}\n\nFan this out`)).toBe('Fan this out');
    expect(stripKnownComposerWirePreamble(`${LEGACY_MOA}\n\nFan this out`)).toBe('Fan this out');
  });

  it('leaves operator text that merely resembles a directive alone', () => {
    const notADirective = 'Multitask this for me please';
    expect(stripKnownComposerWirePreamble(notADirective)).toBe(notADirective);
  });
});

describe('isKnownComposerPreambleTitle', () => {
  it('recognizes titles derived from any mode directive, bracketed or not', () => {
    expect(isKnownComposerPreambleTitle('[Mode: Solo] Work directly in this session')).toBe(true);
    expect(isKnownComposerPreambleTitle('[Mode: Multitask] Decompose this into parallel')).toBe(true);
    expect(isKnownComposerPreambleTitle('[Mode: Mixture of Agents] After the proposal')).toBe(true);
    expect(isKnownComposerPreambleTitle('Mode: Multitask Decompose this into parallel')).toBe(true);
  });

  it('recognizes titles derived from the pre-#2153 directives', () => {
    expect(isKnownComposerPreambleTitle(LEGACY_MULTITASK.slice(0, 48))).toBe(true);
    expect(isKnownComposerPreambleTitle(LEGACY_MOA.slice(0, 48))).toBe(true);
    expect(isKnownComposerPreambleTitle(PRE_RENAME_FAST.slice(0, 48))).toBe(true);
    expect(isKnownComposerPreambleTitle('[Mode: Shared] Work in the current checkout')).toBe(true);
  });

  it('rejects operator-authored titles and non-strings', () => {
    expect(isKnownComposerPreambleTitle('Fix the multitask dispatch bug')).toBe(false);
    expect(isKnownComposerPreambleTitle(null)).toBe(false);
  });
});

describe('modelFacingComposerMessage', () => {
  it('drops the composer directive on a single-mode turn, whichever mode was picked', () => {
    for (const mode of [...MODES, 'fusion'] as ComposerWireMode[]) {
      const { wireMessage } = composeComposerWireMessage('Fix the footer', mode);
      expect(modelFacingComposerMessage(wireMessage, 'single'), mode).toBe('Fix the footer');
    }
  });

  it('keeps the composer directive on fleet and fusion turns', () => {
    const { wireMessage } = composeComposerWireMessage('Fan this out', 'multitask');
    expect(modelFacingComposerMessage(wireMessage, 'fleet')).toBe(wireMessage);
    expect(modelFacingComposerMessage(wireMessage, 'fusion')).toBe(wireMessage);
  });
});
