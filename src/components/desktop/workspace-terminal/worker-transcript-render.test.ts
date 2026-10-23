import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkerActivityTrace } from './chat-renderers/WorkerActivityTrace';
import { WorkerProse } from './chat-renderers/WorkerProse';
import { handbackFromDiff, WorkerHandback } from './chat-renderers/WorkerHandback';
import { workerTranscriptBlocks } from './worker-activity';
import { mapPacketTranscriptEntries } from './use-packet-transcript-poll';
import { normalizeClaudeCodeEvents, normalizeOpencodeEvents } from '@/lib/orchestrator/transcript-normalizer-multi';
import { normalizePiBuiltinEvents } from '@/lib/orchestrator/transcript-normalizer-pi';

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
describe('runtime-neutral worker transcript', () => {
  const logs = [
    normalizeClaudeCodeEvents(jsonl([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'src/router.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Permission denied' }] } },
    ])),
    normalizeOpencodeEvents(jsonl([
      { type: 'tool_use', part: { type: 'tool', callID: 'a', tool: 'read', state: { status: 'running', input: { path: 'src/router.ts' } } } },
      { type: 'tool_use', part: { type: 'tool', callID: 'a', tool: 'read', state: { status: 'error', input: { path: 'src/router.ts' }, output: 'Permission denied' } } },
    ])),
    normalizePiBuiltinEvents(jsonl([
      { type: 'tool_call', id: 'a', name: 'read_file', args: { path: 'src/router.ts' } },
      { type: 'tool_result', id: 'a', name: 'read_file', isError: true, output: 'Permission denied' },
    ])),
  ];
  it.each(logs.map((events, index) => [index, events] as const))('keeps one failed trace row for runtime %s', (_index, events) => {
    const blocks = workerTranscriptBlocks(mapPacketTranscriptEntries([...events]), false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'activity', failed: 1, steps: [{ label: 'Read router.ts', status: 'failed', reason: 'Permission denied' }] });
    if (blocks[0].kind !== 'activity') throw new Error('Expected trace');
    const html = renderToStaticMarkup(createElement(WorkerActivityTrace, { block: blocks[0] }));
    expect(html).toContain('1 command failed');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-activity-step');
  });
  it('renders prose without a bubble and keeps operator pills at 80 percent', () => {
    const html = renderToStaticMarkup(createElement(WorkerProse, { entry: { id: 'a', role: 'assistant', text: '# Result\n\n- Read `router.ts`\n- **Tests pass**' } }));
    expect(html).toContain('data-worker-prose="assistant"');
    expect(html).toContain('background:transparent');
    expect(html).not.toContain('font-size:18px');
    const user = renderToStaticMarkup(createElement(WorkerProse, { entry: { id: 'u', role: 'user', text: 'Continue' } }));
    expect(user).toContain('max-width:80%');
    expect(user).toContain('justify-content:flex-end');
  });
  it('uses authoritative diffstat even with a truncated patch and omits empty diffs', () => {
    expect(handbackFromDiff({ diff: '', stat: ' 4 files changed, 128 insertions(+), 36 deletions(-)', truncated: true })).toMatchObject({ files: 4, additions: 128, deletions: 36 });
    expect(handbackFromDiff({ diff: '', truncated: true })).toBeNull();
    expect(handbackFromDiff({ diff: '' })).toBeNull();
    expect(renderToStaticMarkup(createElement(WorkerHandback, { data: { files: 0, additions: 0, deletions: 0 } }))).toBe('');
    const html = renderToStaticMarkup(createElement(WorkerHandback, { data: { files: 4, additions: 128, deletions: 36, prNumber: 42 } }));
    expect(html).toContain('+128'); expect(html).toContain('−36'); expect(html).toContain('Open PR');
  });
});

it('omits a single file chip when the step label already names that file', () => {
  const [block] = workerTranscriptBlocks([{ id: 'edit', role: 'tool', text: '', toolCalls: [{ name: 'Edit', args: { file_path: 'src/router.ts' }, status: 'done' }] }], true);
  if (block.kind !== 'activity') throw new Error('Expected activity');
  const html = renderToStaticMarkup(createElement(WorkerActivityTrace, { block }));
  expect(html).toContain('Edited router.ts');
  expect(html).not.toContain('title="src/router.ts"');
});

it('retains chips for a multi-file step', () => {
  const [block] = workerTranscriptBlocks([{ id: 'read', role: 'tool', text: '', toolCalls: [{ name: 'exec_command', args: { command: 'cat src/router.ts src/routes.ts' }, status: 'done' }] }], true);
  if (block.kind !== 'activity') throw new Error('Expected activity');
  const html = renderToStaticMarkup(createElement(WorkerActivityTrace, { block }));
  expect(html).toContain('title="src/router.ts"');
  expect(html).toContain('title="src/routes.ts"');
});
