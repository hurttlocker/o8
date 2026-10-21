import { describe, expect, it } from 'vitest';
import { initialChatState, receiveEvent, safeText } from './state.js';
import { editInput } from './input.js';

const route = { repoPath: '/repo', threadId: 'thoughts-test', backend: 'codex' };
const event = (kind: string, data: Record<string, unknown>, seq?: number) => ({
  channel: 'orchestrator', event: kind, seq, data: { ...route, ...data },
});

describe('terminal conversation events', () => {
  it('isolates threads and ignores replayed events', () => {
    let state = initialChatState();
    state = receiveEvent(state, event('output', { text: 'Hello', assistantMessageId: 'a' }, 1), route);
    state = receiveEvent(state, event('output', { text: 'Hello', assistantMessageId: 'a' }, 1), route);
    state = receiveEvent(state, event('output', { threadId: 'thoughts-other', text: 'SECRET' }, 2), route);
    expect(state.messages.map((m) => m.text).join('')).toBe('Hello');
    expect(state.cursor).toBe(1);
  });

  it('discards a rejected attempt without gluing it to the replacement', () => {
    let state = initialChatState();
    state = receiveEvent(state, event('output', { text: 'Attempt one', assistantMessageId: 'a' }, 1), route);
    expect(state.messages[0]?.text).toBe('Attempt one');
    state = receiveEvent(state, event('retry', { assistantMessageId: 'a', notice: 'Retrying' }, 2), route);
    state = receiveEvent(state, event('output', { text: 'Correct response', assistantMessageId: 'a' }, 3), route);
    expect(state.messages[0]?.text).toBe('Correct response');
  });

  it('correlates tool results and keeps failure visible after ready', () => {
    let state = initialChatState();
    state = receiveEvent(state, event('tool-use', { assistantMessageId: 'a', name: 'Read', toolUseId: 't', args: { path: 'a.ts' } }, 1), route);
    state = receiveEvent(state, event('tool-result', { name: 'Read', toolUseId: 't', output: 'denied', isError: true }, 2), route);
    state = receiveEvent(state, event('error', { error: 'Turn failed' }, 3), route);
    state = receiveEvent(state, event('status', { status: 'ready' }, 4), route);
    expect(state.messages[0]?.tools[0]).toMatchObject({ output: 'denied', status: 'error' });
    expect(state.error).toBe('Turn failed');
    expect(state.busy).toBe(false);
  });

  it('strips terminal control sequences from untrusted output', () => {
    expect(safeText('\x1b[2Jhello\x1b]52;c;secret\x07\r\x00')).toBe('hello');
  });
});

describe('terminal composer editing', () => {
  it('pastes multiline text without sending and deletes whole graphemes', () => {
    let value = editInput({ text: '', cursor: 0 }, 'first\r\n👩🏽‍💻', {});
    expect(value.text).toBe('first\n👩🏽‍💻');
    value = editInput(value, '', { backspace: true });
    expect(value.text).toBe('first\n');
  });
  it('edits in the middle and inserts a newline with ctrl+j', () => {
    let value = editInput({ text: 'ab', cursor: 1 }, 'j', { ctrl: true });
    expect(value.text).toBe('a\nb');
    value = editInput(value, '!', {});
    expect(value.text).toBe('a\n!b');
    expect(editInput({ text: 'abc', cursor: 1 }, '', { delete: true })).toEqual({ text: 'ac', cursor: 1 });
  });
});
