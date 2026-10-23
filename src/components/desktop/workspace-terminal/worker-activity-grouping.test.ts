import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { WorkerActivityTrace } from './chat-renderers/WorkerActivityTrace';
import { phasedRecordedWorkerActivity, recordedWorkerActivity } from './fixtures/recorded-worker-activity';
import { humanizeActivity, workerTranscriptBlocks } from './worker-activity';

function entry(command: string, index: number, status: MobileTranscriptToolCall['status'] = 'done'): MobileTranscriptEntry {
  return { id: `entry-${index}`, role: 'tool', text: '', toolCalls: [{ id: `tool-${index}`, name: 'exec_command', args: { command }, status,
    result: status === 'error' ? 'Permission denied' : undefined }] };
}
function render(entries: MobileTranscriptEntry[]) {
  const [block] = workerTranscriptBlocks(entries, true);
  if (block.kind !== 'activity') throw new Error('Expected activity');
  return { block, html: renderToStaticMarkup(createElement(WorkerActivityTrace, { block })) };
}
const rows = (html: string) => [...html.matchAll(/data-activity-step="(\w+)"/g)].map(match => match[1]);

describe('consecutive activity groups through the shared trace', () => {
  it('groups consecutive reads, deduplicates chips and retains every raw command', () => {
    const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'a'].map((file, index) => entry(`cat src/${file}.ts`, index));
    const before = JSON.stringify(entries);
    const { html } = render(entries);
    expect(rows(html)).toEqual(['ok']);
    expect(html).toContain('Read 6 files');
    expect(html).toContain('+2 more');
    expect(html.match(/data-activity-command=/g)).toHaveLength(7);
    expect(JSON.stringify(entries)).toBe(before);
  });
  it('groups by action, preserves order and keeps failures separate from neighboring reads', () => {
    const { html } = render([entry('cat src/a.ts', 0), entry('cat src/b.ts', 1, 'error'), entry('cat src/c.ts', 2),
      entry('git diff', 3), entry('git diff --stat', 4), entry('git status --short', 5), entry('cat src/d.ts', 6)]);
    expect(rows(html)).toEqual(['ok', 'failed', 'ok', 'ok', 'ok', 'ok']);
    expect(html).toContain('Read b.ts');
    expect(html).toContain('Permission denied');
    expect(html).toContain('Checked the diff twice');
    expect(html).toContain('Checked status');
    const labels = [...html.matchAll(/<summary data-activity-label[^>]*>(.*?)<\/summary>/g)].map(match => match[1]);
    expect(labels).toEqual(['Read a.ts', 'Read b.ts', 'Read c.ts', 'Checked the diff twice', 'Checked status', 'Read d.ts']);
  });
  it('uses quoted search chips, with a search icon rather than a file icon', () => {
    const { html } = render([entry('rg -n "lane" src', 0), entry('grep -R "utils" src', 1), entry('rg -e "worker pane" src', 2)]);
    expect(rows(html)).toEqual(['ok']);
    expect(html).toContain('Searched the codebase 3 times');
    expect(html.match(/data-activity-chip="search"/g)).toHaveLength(3);
    expect(html).toContain('&quot;lane&quot;');
    expect(html).toContain('&quot;worker pane&quot;');
    expect(html).not.toContain('data-activity-chip="file"');
    expect(html).toContain('<circle');
  });
  it('keeps native search terms separate from file chips and supports shell pattern options', () => {
    expect(humanizeActivity({ name: 'Grep', args: { pattern: 'lane', path: 'src/router.ts' } })).toMatchObject({
      searchTerms: ['lane'], files: ['src/router.ts'],
    });
    expect(humanizeActivity({ name: 'exec_command', args: { command: 'rg -g "*.ts" -e "lane" --regexp=utils src' } })).toMatchObject({
      searchTerms: ['lane', 'utils'], files: [],
    });
    expect(humanizeActivity({ name: 'exec_command', args: { command: 'find src -name "*.test.ts"' } })).toMatchObject({ searchTerms: ['*.test.ts'] });
    expect(humanizeActivity({ name: 'exec_command', args: { command: 'rg --files src' } })).toMatchObject({ searchTerms: [] });
  });
  it('keeps the live group running and does not merge activity across prose', () => {
    const entries = [entry('cat src/a.ts', 0), entry('cat src/b.ts', 1, 'running')];
    const { html } = render(entries);
    expect(rows(html)).toEqual(['running']);
    expect(html).toContain('Reading 2 files');
    const blocks = workerTranscriptBlocks([entries[0], { id: 'prose', role: 'assistant', text: 'One more file.' }, entries[1]], true);
    expect(blocks.map(block => block.kind)).toEqual(['activity', 'message', 'activity']);
  });
  it('keeps repeated failures separate and retains stopped outcomes in grouped command details', () => {
    const stopped = entry('npm test', 2, 'stopped');
    stopped.toolCalls![0].result = 'Interrupted by operator';
    const { html } = render([entry('npm test', 0, 'error'), entry('npm test', 1, 'error'), stopped, entry('npx vitest run', 3)]);
    expect(rows(html)).toEqual(['failed', 'failed', 'stopped']);
    expect(html).toContain('2 commands failed');
    expect(html).toContain('1 command stopped');
    expect(html).toContain('Interrupted by operator');
    expect(html).toContain('Completed');
  });
  it('keeps different search domains and generic tools in separate groups', () => {
    const web: MobileTranscriptEntry = { id: 'web', role: 'tool', text: '', toolCalls: [{ name: 'web_search', args: { query: 'routing' }, status: 'done' }] };
    const { html } = render([entry('rg routing src', 0), web, entry('python scripts/check.py', 2), entry('node scripts/check.js', 3)]);
    expect(rows(html)).toHaveLength(4);
    expect(html).toContain('Searched the web');
    expect(html).toContain('Ran python');
    expect(html).toContain('Ran node');
  });
  it('names tests, type-checks and lints separately from other commands in the summary', () => {
    const commands = ['npm test', 'npx vitest run', 'npx tsc --noEmit', 'npx eslint src/a.ts', 'python scripts/check.py'];
    const { block } = render(commands.map((command, index) => entry(command, index)));
    expect(block.summary).toContain('Ran tests twice');
    expect(block.summary).toContain('Type-checked');
    expect(block.summary).toContain('Linted');
    expect(block.summary).toContain('Ran 1 command');
    expect(block.summary).not.toContain('Ran 5 commands');
    expect(block.summary).toMatch(/^Ran tests twice · Type-checked · Linted/);
  });
  it('reduces the recorded catalog while preserving every command and its failure status', () => {
    const entries: MobileTranscriptEntry[] = recordedWorkerActivity.map((sample, index) => ({
      id: `recorded-${index}`, role: 'tool', text: '', toolCalls: [{ ...sample.tool, id: `recorded-${index}`,
        status: sample.exitCode === 130 ? 'stopped' : sample.exitCode ? 'error' : 'done',
        result: sample.exitCode ? `Recorded exit code ${sample.exitCode}.` : undefined }],
    }));
    const { html } = render(entries);
    // This catalog interleaves work phases; grouping must not reorder history.
    expect(rows(html).length).toBeLessThanOrEqual(15);
    expect(rows(html).filter(status => status === 'failed')).toHaveLength(2);
    expect(html.match(/data-activity-command=/g)).toHaveLength(31);
  });
  it('fits the complete catalog into 12 rows when its samples are arranged in work phases', () => {
    expect(new Set(phasedRecordedWorkerActivity)).toEqual(new Set(recordedWorkerActivity));
    expect(phasedRecordedWorkerActivity).toHaveLength(recordedWorkerActivity.length);
    const entries: MobileTranscriptEntry[] = phasedRecordedWorkerActivity.map((sample, index) => ({
      id: `phased-${index}`, role: 'tool', text: '', toolCalls: [{ ...sample.tool, id: `phased-${index}`,
        status: sample.exitCode === 130 ? 'stopped' : sample.exitCode ? 'error' : 'done',
        result: sample.exitCode ? `Recorded exit code ${sample.exitCode}.` : undefined }],
    }));
    const { html } = render(entries);
    expect(rows(html)).toHaveLength(12);
    expect(rows(html).filter(status => status === 'failed')).toHaveLength(2);
    expect(html.match(/data-activity-command=/g)).toHaveLength(31);
    expect(html).toContain('2 commands stopped');
  });
});
