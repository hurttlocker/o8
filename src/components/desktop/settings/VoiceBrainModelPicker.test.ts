// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceBrainModelPicker } from './VoiceBrainModelPicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('VoiceBrainModelPicker', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it('saves the selected native model id and clears back to Automatic', async () => {
    let stored: string | null = null;
    const onChange = vi.fn(async (model: string) => { stored = model; render(); });
    function render() { root.render(createElement(VoiceBrainModelPicker, { provider: 'codex', value: stored, onChange })); }
    await act(async () => { render(); });
    const select = container.querySelector('select')!;
    await act(async () => { select.value = 'gpt-5.6-terra'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('gpt-5.6-terra');
    expect(select.value).toBe('gpt-5.6-terra');
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(stored).toBe('');
    expect(select.value).toBe('');
  });

  it('preserves an existing incompatible override without silently saving a replacement', async () => {
    const onChange = vi.fn();
    await act(async () => { root.render(createElement(VoiceBrainModelPicker, { provider: 'codex', value: 'claude-opus-5', onChange })); });
    expect(container.querySelector('select')!.value).toBe('claude-opus-5');
    expect(container.textContent).toContain('Saved override: claude-opus-5');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('retains the saved choice and reports a failed write', async () => {
    const onChange = vi.fn(async () => { throw new Error('unavailable'); });
    await act(async () => { root.render(createElement(VoiceBrainModelPicker, { provider: 'codex', value: null, onChange })); });
    const select = container.querySelector('select')!;
    await act(async () => { select.value = 'gpt-5.6-sol'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
    expect(select.value).toBe('');
    expect(select.disabled).toBe(false);
  });
  it('loads OpenCode choices from its catalog and saves the exact provider/model id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ groups: [{ provider: 'openrouter', models: [{ id: 'openrouter/example/model', label: 'Example model', provider: 'openrouter', efforts: [] }] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const onChange = vi.fn(async () => {});
    await act(async () => { root.render(createElement(VoiceBrainModelPicker, { provider: 'opencode', value: null, onChange })); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click(); });
    expect(fetchMock.mock.calls[0][0]).toContain('/api/orchestrator/backend-models?backend=opencode');
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label^="Provider "]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[title="openrouter/example/model"]')!.click(); });
    expect(onChange).toHaveBeenCalledWith('openrouter/example/model');
  });

});
