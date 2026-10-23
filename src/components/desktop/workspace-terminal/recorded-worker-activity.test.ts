import { describe, expect, it } from 'vitest';
import { humanizeActivity, workerTranscriptBlocks } from './worker-activity';
import { recordedWorkerActivity } from './fixtures/recorded-worker-activity';

describe('sanitized recorded worker activity', () => {
  it.each(recordedWorkerActivity.map((sample, index) => ({ ...sample, index })))('uses $expectedVerb for recorded sample $index', ({ tool, expectedVerb }) => {
    expect(humanizeActivity(tool).label).toMatch(new RegExp(`^${expectedVerb}(?: |$)`));
  });
  it('keeps a recorded nonzero command visible as failed', () => {
    const failed = recordedWorkerActivity.find(sample => sample.exitCode === 1)!;
    const [block] = workerTranscriptBlocks([{ id: 'recorded-failure', role: 'tool', text: '', toolCalls: [{ ...failed.tool, status: 'error', result: 'Command exited with code 1.' }] }], false);
    expect(block).toMatchObject({ failed: 1, steps: [{ status: 'failed', label: 'Ran tests' }] });
  });
  it('uses once for one search and counts for repeated searches', () => {
    const search = { name: 'exec_command', args: { command: 'rg --files src' }, status: 'done' as const };
    const entry = { id: 'search', role: 'tool' as const, text: '', toolCalls: [search] };
    expect(workerTranscriptBlocks([entry], false)[0]).toMatchObject({ summary: 'Searched once' });
    expect(workerTranscriptBlocks([entry, { ...entry, id: 'search-2' }], false)[0]).toMatchObject({ summary: 'Searched 2 times' });
  });
});

it('does not turn recorded redirections or revision ranges into file chips', () => {
  const samples = recordedWorkerActivity.filter(sample => typeof sample.tool.args?.command === 'string');
  const test = samples.find(sample => String(sample.tool.args?.command).includes('finished-verified.log'))!;
  expect(humanizeActivity(test.tool).files).toEqual(['tests/finished-packet-retirement-cli-real-path.test.ts']);
  const revision = samples.find(sample => String(sample.tool.args?.command).includes('main...HEAD'))!;
  expect(humanizeActivity(revision.tool).files).toEqual([]);
  for (const sample of samples) expect(humanizeActivity(sample.tool).files).not.toContain('/dev/null');
});
