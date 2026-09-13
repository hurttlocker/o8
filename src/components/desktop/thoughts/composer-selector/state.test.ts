// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { composeComposerTurnMessage } from '../composer-mode';
import {
  resolveComposerSelectorState,
  readComposerEffortMaps,
  setModelEffort,
  type ComposerSelectorMode,
} from './state';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const MODES: ComposerSelectorMode[] = ['solo', 'multitask', 'moa', 'fusion'];
const EFFORTS: ThinkingEffort[] = ['low', 'medium', 'adaptive', 'high', 'xhigh', 'max', 'ultra'];

describe('composer selector state', () => {
  beforeEach(() => localStorage.clear());

  it('keeps mode, wire directive, execution mode, and effort in one resolved state', () => {
    for (const mode of MODES) {
      for (const effort of EFFORTS) {
        const resolved = resolveComposerSelectorState({
          mode,
          leadModelId: 'gpt-6-astra',
          leadModelLabel: 'Astra',
          leadBackend: 'codex',
          inSessionEffortByModel: { 'gpt-6-astra': effort },
          threadEffortByModel: {},
          operatorDefaultEffort: 'medium',
          adaptiveEnabled: true,
          workerRuntimeLabel: 'Codex',
          workerModelLabel: 'Sol',
        });
        const turn = composeComposerTurnMessage('Build it', resolved.mode, false, false);

        expect(turn.orchestrationMode, mode).toBe(resolved.orchestrationMode);
        expect(turn.wireMessage, mode).toContain(resolved.modeDirective);
        expect(resolved.effort, `${mode}:${effort}`).toBe(effort);
      }
    }
  });

  it('restores each model effort across A to B to A', () => {
    let efforts = setModelEffort({}, 'model-a', 'high');
    efforts = setModelEffort(efforts, 'model-b', 'low');
    const resolve = (modelId: string) => resolveComposerSelectorState({
      mode: 'solo',
      leadModelId: modelId,
      leadModelLabel: modelId,
      leadBackend: 'claude',
      inSessionEffortByModel: efforts,
      threadEffortByModel: {},
      operatorDefaultEffort: 'medium',
      adaptiveEnabled: true,
      workerRuntimeLabel: 'Codex',
    }).effort;

    expect(resolve('model-a')).toBe('high');
    expect(resolve('model-b')).toBe('low');
    expect(resolve('model-a')).toBe('high');
  });

  it('migrates the legacy effort once without consuming the classic key', () => {
    localStorage.setItem('o8:orchestrator:thinking-effort', 'high');
    expect(readComposerEffortMaps(null, 'model-a').global['model-a']).toBe('high');
    expect(localStorage.getItem('o8:orchestrator:thinking-effort')).toBe('high');

    localStorage.setItem('o8:orchestrator:thinking-effort', 'low');
    expect(readComposerEffortMaps(null, 'model-b').global['model-b']).toBeUndefined();
  });

  it('clamps unsupported high-end efforts to the runtime ceiling', () => {
    const resolved = resolveComposerSelectorState({
      mode: 'solo',
      leadModelId: 'gpt-5.6-terra',
      leadModelLabel: 'Terra',
      leadBackend: 'codex',
      inSessionEffortByModel: { 'gpt-5.6-terra': 'ultra' },
      threadEffortByModel: {},
      operatorDefaultEffort: 'medium',
      adaptiveEnabled: true,
      workerRuntimeLabel: 'Codex',
    });

    expect(resolved.effort).toBe('xhigh');
    expect(resolved.effortOptions).not.toContain('max');
    expect(resolved.effortOptions).not.toContain('ultra');
    expect(resolved.chipTitle).toContain('ultra is unsupported for Terra; clamped to xhigh');
  });

  it('keeps the free backend on its real low tier while hiding effort controls', () => {
    const resolved = resolveComposerSelectorState({
      mode: 'solo',
      leadModelId: 'o8-free',
      leadModelLabel: 'o8',
      leadBackend: 'o8',
      inSessionEffortByModel: { 'o8-free': 'high' },
      threadEffortByModel: {},
      operatorDefaultEffort: 'max',
      adaptiveEnabled: true,
      isFreePlan: true,
      workerRuntimeLabel: 'Codex',
    });

    expect(resolved.effort).toBe('low');
    expect(resolved.effortOptions).toEqual([]);
  });

  it('resolves in-session over thread over operator default', () => {
    const base = {
      mode: 'solo' as const,
      leadModelId: 'model-a',
      leadModelLabel: 'Model A',
      leadBackend: 'claude' as const,
      adaptiveEnabled: true,
      workerRuntimeLabel: 'Codex',
      workerModelLabel: 'Sol',
    };

    expect(resolveComposerSelectorState({
      ...base,
      inSessionEffortByModel: { 'model-a': 'max' },
      threadEffortByModel: { 'model-a': 'high' },
      operatorDefaultEffort: 'medium',
    }).effort).toBe('max');
    expect(resolveComposerSelectorState({
      ...base,
      inSessionEffortByModel: {},
      threadEffortByModel: { 'model-a': 'high' },
      operatorDefaultEffort: 'medium',
    }).effort).toBe('high');
    expect(resolveComposerSelectorState({
      ...base,
      inSessionEffortByModel: {},
      threadEffortByModel: {},
      operatorDefaultEffort: 'medium',
    }).effort).toBe('medium');
  });
});
