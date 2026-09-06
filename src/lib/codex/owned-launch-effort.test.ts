/**
 * Worker reasoning-effort at the CODEX launch surface. Two must-proves:
 *  1. PARITY — no effort ⇒ NO model_reasoning_effort flag; launch args are
 *     byte-identical to before this feature.
 *  2. PER-RUNTIME (codex) — an explicit tier ⇒ `-c model_reasoning_effort=<x>`
 *     (max → xhigh); adaptive/unset stay at the runtime default.
 */

import { describe, it, expect } from 'vitest';

import { codexLaunchArgs, codexReasoningEffortArgs } from './owned';
import { resolveWorkerEffortDefault } from '@/lib/operator/worker-effort-default';

describe('codexReasoningEffortArgs', () => {
  it('unset / adaptive ⇒ [] (no flag — parity, runtime default)', () => {
    expect(codexReasoningEffortArgs(undefined)).toEqual([]);
    expect(codexReasoningEffortArgs('adaptive')).toEqual([]);
  });

  it('explicit tiers ⇒ the -c model_reasoning_effort flag; max → xhigh (no model = not Sol)', () => {
    expect(codexReasoningEffortArgs('low')).toEqual(['-c', 'model_reasoning_effort=low']);
    expect(codexReasoningEffortArgs('high')).toEqual(['-c', 'model_reasoning_effort=high']);
    expect(codexReasoningEffortArgs('xhigh')).toEqual(['-c', 'model_reasoning_effort=xhigh']);
    expect(codexReasoningEffortArgs('max')).toEqual(['-c', 'model_reasoning_effort=xhigh']);
    expect(codexReasoningEffortArgs('ultra')).toEqual(['-c', 'model_reasoning_effort=xhigh']);
  });

  it('max/ultra pass through on Astra and Sol; terra/luna/5.5 clamp to xhigh', () => {
    expect(codexReasoningEffortArgs('max', 'gpt-6-astra')).toEqual(['-c', 'model_reasoning_effort=max']);
    expect(codexReasoningEffortArgs('ultra', 'gpt-6-astra')).toEqual(['-c', 'model_reasoning_effort=ultra']);
    expect(codexReasoningEffortArgs('max', 'gpt-5.6-sol')).toEqual(['-c', 'model_reasoning_effort=max']);
    expect(codexReasoningEffortArgs('ultra', 'gpt-5.6-sol')).toEqual(['-c', 'model_reasoning_effort=ultra']);
    // Non-Sol 5.6 tiers + prior gen clamp down (worker default is Terra).
    expect(codexReasoningEffortArgs('max', 'gpt-5.6-terra')).toEqual(['-c', 'model_reasoning_effort=xhigh']);
    expect(codexReasoningEffortArgs('ultra', 'gpt-5.6-luna')).toEqual(['-c', 'model_reasoning_effort=xhigh']);
    expect(codexReasoningEffortArgs('max', 'gpt-5.5')).toEqual(['-c', 'model_reasoning_effort=xhigh']);
    // A concrete sub-xhigh tier is unaffected by the model.
    expect(codexReasoningEffortArgs('high', 'gpt-5.6-sol')).toEqual(['-c', 'model_reasoning_effort=high']);
  });
});

describe('codexLaunchArgs — effort', () => {
  const base = { cwd: '/repo', prompt: 'do the thing' };

  it('PARITY: no effort ⇒ launch args identical to effort:undefined, and NO reasoning flag', () => {
    const noArg = codexLaunchArgs({ ...base, model: 'gpt-5.5' });
    const explicitUndefined = codexLaunchArgs({ ...base, model: 'gpt-5.5', effort: undefined });
    expect(noArg).toEqual(explicitUndefined);
    expect(noArg.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('adaptive ⇒ still no reasoning flag (runtime default)', () => {
    expect(codexLaunchArgs({ ...base, effort: 'adaptive' }).join(' ')).not.toContain('model_reasoning_effort');
  });

  it('explicit effort ⇒ the flag is present, once', () => {
    const args = codexLaunchArgs({ ...base, model: 'gpt-5.5', effort: 'high' });
    expect(args).toContain('model_reasoning_effort=high');
    expect(args.filter((a) => a.startsWith('model_reasoning_effort='))).toHaveLength(1);
    // prompt is still last (flag inserted before it, not after)
    expect(args[args.length - 1]).toBe('do the thing');
  });

  it('default effort lands in Codex launch args when launch did not specify effort', () => {
    const effort = resolveWorkerEffortDefault({
      runtime: 'codex',
      explicitEffort: undefined,
      codexWorkerEffort: 'xhigh',
      claudeWorkerEffort: 'max',
    });
    expect(codexLaunchArgs({ ...base, model: 'gpt-5.5', effort })).toContain('model_reasoning_effort=xhigh');
  });

  it('explicit effort beats the Codex default effort', () => {
    const effort = resolveWorkerEffortDefault({
      runtime: 'codex',
      explicitEffort: 'high',
      codexWorkerEffort: 'xhigh',
      claudeWorkerEffort: 'max',
    });
    const args = codexLaunchArgs({ ...base, model: 'gpt-5.5', effort });
    expect(args).toContain('model_reasoning_effort=high');
    expect(args).not.toContain('model_reasoning_effort=xhigh');
  });
});
