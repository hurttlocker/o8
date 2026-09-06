import { describe, expect, it } from 'vitest';
import { detectRunSandboxDenial, detectSandboxDenial } from './sandbox-denial';

describe('sandbox denial diagnostic text', () => {
  it.each([
    '(deny file-read* file-write* (subpath "/example"))',
    JSON.stringify({ output: 'deny file-read-data /example/secret' }),
    'The example says: cat: /example/secret: Operation not permitted',
  ])('ignores quoted policy and diagnostic examples: %s', (text) => {
    expect(detectSandboxDenial(text)).toBeNull();
  });

  it.each([
    ['Sandbox: cat(42) deny(1) file-read-data /example/secret', 'file-read'],
    ['deny(1) process-exec /example/tool', 'process-exec'],
    ['cat: /example/secret: Operation not permitted', 'file-read'],
    ['cat: relative-file: Operation not permitted', 'file-read'],
    ['sandbox-exec: execvp() of "/example/tool" failed: Operation not permitted', 'process-exec'],
    ['chmod: Unable to change file mode on /example/secret: Operation not permitted', 'file-write'],
    ['sandbox-exec: sandbox_apply: Operation not permitted', 'sandbox-apply'],
  ])('recognizes anchored diagnostics: %s', (text, operation) => {
    expect(detectSandboxDenial(text)?.operation).toBe(operation);
  });

  it('bounds diagnostic fields before they enter persisted events', () => {
    const denial = detectSandboxDenial('cat: /' + 'x'.repeat(20000) + ': Operation not permitted');
    expect(denial).not.toBeNull();
    expect(denial!.resource.length).toBeLessThanOrEqual(512);
    expect(denial!.line.length).toBeLessThanOrEqual(1024);
  });

  it.each([false, true])('uses explicit tool failure identity: %s', (failed) => {
    const text = 'cat: /example/secret: Operation not permitted';
    const stream = JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', is_error: failed, content: [{ type: 'text', text }] },
    ] } });
    expect(Boolean(detectRunSandboxDenial('claude-code', stream, ''))).toBe(failed);
    expect(detectRunSandboxDenial('codex', stream, '')).toBeNull();
    const command = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution',
      exit_code: failed ? 1 : 0, aggregated_output: text } });
    expect(Boolean(detectRunSandboxDenial('codex', command, ''))).toBe(failed);
  });

  it('ignores prose, partial JSON, null and nested example envelopes', () => {
    const example = { type: 'user', message: { content: [{ type: 'tool_result', is_error: true,
      content: 'cat: /example/secret: Operation not permitted' }] } };
    expect(detectRunSandboxDenial('claude-code', ['null', '{', 'deny(1) file-read-data /example',
      JSON.stringify({ type: 'assistant', message: { content: JSON.stringify(example) } }),
    ].join('\n'), '')).toBeNull();
  });
});
