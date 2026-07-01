/**
 * Targeting observability — asserts the structured log grammar the future
 * recalibration loop will parse. Format regression guard.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import type { TargetScore } from './scorer';
import { logDispatchChoice, logTriageRun } from './observability';

const score = (path: string, s: number): TargetScore => ({
  path, impact: 4, opportunity: 4, score: s, rationale: 'x',
  signals: { path, loc: 100, symbolCount: 5, outboundImports: 3, inbound: 10, churn: 4 },
});

afterEach(() => vi.restoreAllMocks());

describe('logTriageRun', () => {
  it('emits a parseable [targeting] triaged line with repo, count, mode, top', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logTriageRun('/repo', [score('a.ts', 16), score('b.ts', 9)], 'llm');
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain('[targeting] triaged');
    expect(line).toContain('repo=/repo');
    expect(line).toContain('files=2');
    expect(line).toContain('rationales=llm');
    expect(line).toContain('a.ts=16');
  });
});

describe('logDispatchChoice', () => {
  it('emits a parseable [targeting] dispatch line with the ground-truth fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logDispatchChoice({
      repoPath: '/repo', path: 'a.ts', missionId: 'm1',
      tier: 'action', runtime: 'codex', model: null, effort: 'high',
      impact: 4, opportunity: 5, score: 20,
    });
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain('[targeting] dispatch');
    expect(line).toContain('path=a.ts');
    expect(line).toContain('tier=action');
    expect(line).toContain('runtime=codex');
    expect(line).toContain('model=default'); // null → 'default'
    expect(line).toContain('effort=high');
    expect(line).toContain('score=20');
    expect(line).toContain('mission=m1');
  });
});
