import { describe, expect, it } from 'vitest';

import {
  COMPOSER_MODE_DIRECTIVES,
  composeComposerWireMessage,
  isKnownComposerPreambleTitle,
  resolveOrchestratorTranscriptMessage,
  stripKnownComposerWirePreamble,
  type ComposerWireMode,
} from './composer-wire';

const MODES: ComposerWireMode[] = ['solo', 'multitask', 'moa'];

/** Directives as o8 shipped them before #2153 — still on the wire from old clients. */
const LEGACY_MULTITASK = '[Mode: Multitask] Decompose this into parallel worker packets and dispatch them into isolated worktrees instead of working serially yourself. Review and merge through the gate as they finish.';
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
  });

  it('rejects operator-authored titles and non-strings', () => {
    expect(isKnownComposerPreambleTitle('Fix the multitask dispatch bug')).toBe(false);
    expect(isKnownComposerPreambleTitle(null)).toBe(false);
  });
});
