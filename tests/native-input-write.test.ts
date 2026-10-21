// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rust = readFileSync(join(process.cwd(), 'tauri-plugin-mcp/src/tools/webview.rs'), 'utf8');
const template = /const TYPE_INTO_FOCUSED_JS: &str = r#"([\s\S]*?)"#;/.exec(rust)?.[1];
if (!template) throw new Error('Production focused typing script was not found');
type Reply = { correlationId: string; ok: boolean; data: { charsTyped: number } | null; error: string | null };
const nativeWindow = window as typeof window & {
  __TAURI_INTERNALS__?: { invoke: (command: string, reply: Reply) => Promise<void> };
  __mcpLastFocusedElement?: Element; __mcpLastClickCoords?: { x: number; y: number };
};
let host: HTMLDivElement;
let root: Root;
const changed = vi.fn();
const replies: Reply[] = [];
let scriptTimer: typeof setTimeout | undefined;
function Field({ tag, refuse = false }: { tag: 'input' | 'textarea'; refuse?: boolean }) {
  const [value, setValue] = useState('prefix: ');
  return createElement('section', {}, createElement(tag, { value, onChange: (event: { currentTarget: { value: string } }) => {
    changed(event.currentTarget.value); if (!refuse) setValue(event.currentTarget.value);
  } }), createElement('output', {}, value));
}
function run(payload: Record<string, unknown>) {
  const code = template!.replaceAll('{{payload}}', JSON.stringify(payload)).replaceAll('{{correlationId}}', JSON.stringify('typing-fixture'));
  return new Function('setTimeout', `return ${code.trim()}`)(scriptTimer ?? setTimeout) as Promise<void>;
}
function stalledTimers() {
  // Bind only the production script's timer; jsdom's native selection API
  // schedules unrelated select/selectionchange events internally.
  const timer = vi.fn(() => 0 as unknown as ReturnType<typeof setTimeout>);
  scriptTimer = timer as unknown as typeof setTimeout; return timer;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  replies.length = 0; changed.mockClear(); scriptTimer = undefined;
  nativeWindow.__TAURI_INTERNALS__ = { invoke: async (command, reply) => {
    expect(command).toBe('mcp_result'); expect(reply.correlationId).toBe('typing-fixture'); replies.push(reply);
  } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  vi.restoreAllMocks(); act(() => root.unmount()); host.remove();
  delete nativeWindow.__TAURI_INTERNALS__; delete nativeWindow.__mcpLastFocusedElement; delete nativeWindow.__mcpLastClickCoords;
});
describe('production native script -> ordinary React-controlled fields', () => {
  it.each(['input', 'textarea'] as const)('appends exactly to %s and updates React without scheduling timers', async tag => {
    act(() => root.render(createElement(Field, { tag })));
    const field = host.querySelector(tag)!; field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    const text = tag === 'textarea' ? 'first\nsecond\n🙂' : 'ordinary 🙂 text';
    const timer = stalledTimers();
    const bubbled = vi.fn(); host.addEventListener('input', bubbled);
    await act(async () => { void run({ text, delayMs: 0 }); await Promise.resolve(); });
    expect(replies).toEqual([expect.objectContaining({ ok: true, data: expect.objectContaining({ charsTyped: text.length }) })]);
    expect(field.value).toBe('prefix: ' + text); expect(host.querySelector('output')?.textContent).toBe(field.value);
    expect(changed).toHaveBeenCalledExactlyOnceWith('prefix: ' + text); expect(bubbled).toHaveBeenCalledTimes(1);
    expect(timer).not.toHaveBeenCalled();
  });
  it.each([
    ['input', 'caret-middle', 3, 3], ['textarea', 'caret-middle', 3, 3],
    ['input', 'selection', 2, 6], ['textarea', 'selection', 2, 6],
    ['input', 'select-all', 0, 8], ['textarea', 'select-all', 0, 8],
  ] as const)('inserts into %s at %s and preserves React state and caret', async (tag, _mode, start, end) => {
    act(() => root.render(createElement(Field, { tag })));
    const field = host.querySelector(tag)!; field.focus(); field.setSelectionRange(start, end);
    const text = tag === 'textarea' ? 'first\nsecond🙂' : '🙂X';
    const expected = field.value.slice(0, start) + text + field.value.slice(end);
    const timer = stalledTimers(); const bubbled = vi.fn(); host.addEventListener('input', bubbled);
    await act(async () => { void run({ text, delayMs: 0 }); await Promise.resolve(); });
    expect(replies[0]).toMatchObject({ ok: true }); expect(field.value).toBe(expected);
    expect(host.querySelector('output')?.textContent).toBe(expected); expect(changed).toHaveBeenCalledExactlyOnceWith(expected);
    expect(field.selectionStart).toBe(start + text.length); expect(field.selectionEnd).toBe(start + text.length);
    expect(bubbled).toHaveBeenCalledTimes(1); expect(timer).not.toHaveBeenCalled();
  });
  it.each([[null, null], [-1, 2], [NaN, 2], [4, 2], [0, 99]] as const)('refuses invalid selection bounds %s/%s without mutation', async (start, end) => {
    const field = document.createElement('textarea'); field.value = 'preserved'; host.append(field); field.focus();
    Object.defineProperty(field, 'selectionStart', { get: () => start }); Object.defineProperty(field, 'selectionEnd', { get: () => end });
    const event = vi.fn(); field.addEventListener('input', event); const timer = stalledTimers();
    void run({ text: 'insert', delayMs: 0 }); await Promise.resolve();
    expect(replies[0]).toMatchObject({ ok: false }); expect(field.value).toBe('preserved');
    expect(event).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
  });
  it('refuses input types without a selection API without changing them', async () => {
    const field = document.createElement('input'); field.type = 'email'; field.value = 'fixture@example.test'; host.append(field); field.focus();
    const event = vi.fn(); field.addEventListener('input', event); const timer = stalledTimers();
    void run({ text: 'insert', delayMs: 0 }); await Promise.resolve();
    expect(replies[0]).toMatchObject({ ok: false }); expect(field.value).toBe('fixture@example.test');
    expect(event).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'readOnly', 'disconnected', 'fieldset'] as const)('refuses %s before mutation or focus recovery', async mode => {
    const field = document.createElement('textarea'); field.value = 'preserved';
    host.append(field); field.focus();
    if (mode === 'disabled' || mode === 'readOnly') field[mode] = true;
    if (mode === 'disconnected') field.remove();
    if (mode === 'fieldset') { const group = document.createElement('fieldset'); group.disabled = true; host.append(group); group.append(field); }
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(field);
    const focus = vi.spyOn(field, 'focus'); const event = vi.fn(); field.addEventListener('input', event);
    const timer = stalledTimers(); void run({ text: 'append', delayMs: 0 }); await Promise.resolve();
    expect(replies[0]).toMatchObject({ ok: false, data: null });
    expect(field.value).toBe('preserved'); expect(focus).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
  });
  it('does not focus a stale ordinary field hint when no current field is focused', async () => {
    const field = document.createElement('textarea'); field.value = 'preserved'; host.append(field);
    nativeWindow.__mcpLastFocusedElement = field; nativeWindow.__mcpLastClickCoords = { x: 1, y: 1 };
    const focus = vi.spyOn(field, 'focus'); const timer = stalledTimers();
    void run({ text: 'append', delayMs: 0 }); await Promise.resolve();
    expect(replies[0]).toMatchObject({ ok: false }); expect(field.value).toBe('preserved'); expect(focus).not.toHaveBeenCalled(); expect(timer).not.toHaveBeenCalled();
  });
  it('reports refusal when a controlled handler restores the original value, with no late writes', async () => {
    act(() => root.render(createElement(Field, { tag: 'textarea', refuse: true })));
    const field = host.querySelector('textarea')!; field.focus();
    const timer = stalledTimers(); await act(async () => { void run({ text: 'append', delayMs: 0 }); await Promise.resolve(); });
    expect(replies[0]).toMatchObject({ ok: false }); expect(field.value).toBe('prefix: ');
    expect(timer).not.toHaveBeenCalled(); await Promise.resolve(); expect(field.value).toBe('prefix: ');
  });
  it('refuses input value sanitization before changing the original field', async () => {
    const field = document.createElement('input'); field.value = 'prefix'; host.append(field); field.focus();
    const timer = stalledTimers(); void run({ text: '\nline', delayMs: 0 }); await Promise.resolve();
    expect(replies[0]).toMatchObject({ ok: false }); expect(field.value).toBe('prefix'); expect(timer).not.toHaveBeenCalled();
  });
  it('retains the explicit paced native path', async () => {
    const field = document.createElement('textarea'); host.append(field); field.focus();
    const timer = stalledTimers(); void run({ text: 'paced', delayMs: 20 }); await Promise.resolve();
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 50); expect(replies).toHaveLength(0);
  });
  it('completes long rich-editor input beyond the old ten-second timeout', async () => {
    const editor = document.createElement('div'); editor.tabIndex = 0;
    Object.defineProperty(editor, 'isContentEditable', { value: true }); host.append(editor); editor.focus();
    vi.useFakeTimers();
    try {
      const text = 'a'.repeat(1000); const completion = run({ text, delayMs: 0 });
      await vi.advanceTimersByTimeAsync(10000); expect(replies).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(11000); await completion;
      expect(editor.textContent).toBe(text); expect(replies[0]).toMatchObject({ ok: true });
    } finally { vi.useRealTimers(); }
  });
  it('keeps the rich contenteditable route paced for normal zero-delay client calls', async () => {
    const editor = document.createElement('div'); editor.tabIndex = 0;
    Object.defineProperty(editor, 'isContentEditable', { value: true }); host.append(editor); editor.focus();
    const scheduled: Array<{ callback: () => void; ms?: number }> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms) => {
      scheduled.push({ callback: callback as () => void, ms }); return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const completion = run({ text: 'ab', delayMs: 0 });
    expect(scheduled[0].ms).toBe(50); scheduled[0].callback(); await Promise.resolve();
    expect(scheduled[1].ms).toBe(50); scheduled[1].callback(); await Promise.resolve();
    const characterDelay = scheduled.find(task => task.ms === 20);
    expect(characterDelay).toBeDefined(); characterDelay!.callback(); await completion;
    expect(editor.textContent).toBe('ab'); expect(replies[0]).toMatchObject({ ok: true });
  });

});
