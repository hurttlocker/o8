import { afterEach, describe, expect, it, vi } from 'vitest';

import { runProblem } from './problem';

const responseBody = {
  schema: 'o8/problem-dossiers/v1',
  dossiers: [{
    id: 'problem-stable',
    projectId: 'project-a',
    repoPath: '/tmp/repo-a',
    painStatement: 'verification failed repeatedly',
    status: 'candidate',
    occurrenceCount: 3,
    comparableExposureCount: 0,
    impactBand: 'moderate',
    evidenceConfidence: 'high',
    linkedTaskId: null,
    closureContract: { requiredComparableExposures: 3 },
    firstObservedAt: '2026-08-13T10:00:00.000Z',
    lastObservedAt: '2026-08-13T12:00:00.000Z',
    evidence: [],
    remedies: [],
  }],
  summary: { total: 1, actionable: 1 },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.O8_API_PORT;
});

describe('o8 problem', () => {
  it('lists and shows the same stable persisted dossier identity', async () => {
    process.env.O8_API_PORT = '47120';
    const fetchMock = vi.fn().mockImplementation(() => (
      Promise.resolve(new Response(JSON.stringify(responseBody), { status: 200 }))
    ));
    vi.stubGlobal('fetch', fetchMock);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await expect(runProblem({ human: false, verbose: false }, 'list', ['--all'])).resolves.toBe(0);
    await expect(runProblem({ human: false, verbose: false }, 'show', ['problem-stable'])).resolves.toBe(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('includeSuppressed=true');
    expect(writes.join('')).toContain('o8/cli/problem.list/v1');
    expect(writes.join('')).toContain('o8/cli/problem.show/v1');
    expect(writes.join('')).toContain('problem-stable');
  });
});
