// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  desktop: true,
  nonMacShell: false,
  prefsReadFails: false,
  prefs: {} as Record<string, unknown>,
  writes: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/tauri/bridge', () => ({
  isTauri: () => native.desktop,
  voicePrefsGet: async () => native.prefsReadFails ? null : ({ ...native.prefs }),
  voicePrefsSet: async (key: string, value: unknown) => {
    native.writes.push([key, value]);
    native.prefs[`${key}_set`] = value !== '';
  },
}));

vi.mock('@/lib/desktop/host-platform', () => ({
  isNonMacShell: () => native.nonMacShell,
}));

import { APIKeysTab } from './APIKeysTab';

const providers = [
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', placeholder: 'sk-or-...', docsUrl: '#', configured: false, maskedKey: null },
  { id: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', placeholder: 'sk-...', docsUrl: '#', configured: false, maskedKey: null },
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...', docsUrl: '#', configured: false, maskedKey: null },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', placeholder: 'sk-...', docsUrl: '#', configured: false, maskedKey: null },
];

function providerFetch() {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ providers }) }));
}

function rowFor(container: HTMLElement, label: string): HTMLElement {
  const labelNode = [...container.querySelectorAll('span')].find((node) => node.textContent === label);
  if (!labelNode) throw new Error(`Missing row label: ${label}`);
  let row: HTMLElement | null = labelNode.parentElement;
  while (row && ![...row.querySelectorAll('button')].some((button) => button.textContent?.includes('key'))) {
    row = row.parentElement;
  }
  if (!row) throw new Error(`Missing interactive row: ${label}`);
  return row;
}

beforeEach(() => {
  native.desktop = true;
  native.nonMacShell = false;
  native.prefsReadFails = false;
  native.prefs = {};
  native.writes = [];
  vi.stubGlobal('fetch', providerFetch());
});

it('shows the four app-service keys and five distinct native Keychain slots', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(APIKeysTab)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('OpenRouter (app services)');
    expect(container.textContent).toContain('DeepSeek');
    expect(container.textContent).toContain('Anthropic');
    expect(container.textContent).toContain('OpenAI');
    expect(container.textContent).toContain('Gemini (Symon & voice)');
    expect(container.textContent).toContain('OpenRouter (Symon & voice)');
    expect(container.textContent).toContain('Groq transcription');
    expect(container.textContent).toContain('ElevenLabs voice');
    expect(container.textContent).toContain('Google Cloud TTS');
    expect(container.textContent).toContain('separate from the app-services key above');
  } finally {
    act(() => root.unmount());
  }
});

it('saves and removes native keys through presence-only Keychain readback', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(APIKeysTab)); });
    await act(async () => { await Promise.resolve(); });
    let row = rowFor(container, 'ElevenLabs voice');
    const add = [...row.querySelectorAll('button')].find((button) => button.textContent === 'add key')!;
    await act(async () => { add.click(); });
    row = rowFor(container, 'ElevenLabs voice');
    const input = row.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'fixture-eleven-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    const save = [...row.querySelectorAll('button')].find((button) => button.textContent === 'save key')!;
    await act(async () => { save.click(); });
    expect(native.writes).toContainEqual(['elevenlabs_api_key', 'fixture-eleven-key']);
    row = rowFor(container, 'ElevenLabs voice');
    expect(row.textContent).toContain('saved here');
    const remove = [...row.querySelectorAll('button')].find((button) => button.textContent === 'remove')!;
    await act(async () => { remove.click(); });
    expect(native.writes).toContainEqual(['elevenlabs_api_key', '']);
    expect(rowFor(container, 'ElevenLabs voice').textContent).toContain('not saved here');
  } finally {
    act(() => root.unmount());
  }
});

it('marks native keys macOS-only without exposing inert editors in a browser', async () => {
  native.desktop = false;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(APIKeysTab)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent?.match(/macOS only/g)).toHaveLength(5);
    expect(rowFor(container, 'OpenRouter (app services)').textContent).toContain('add key');
    const nativeLabel = [...container.querySelectorAll('span')].find((node) => node.textContent === 'Gemini (Symon & voice)')!;
    expect(nativeLabel.parentElement?.parentElement?.parentElement?.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('does not expose macOS Keychain editors in a Windows or Linux shell', async () => {
  native.nonMacShell = true;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(APIKeysTab)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent?.match(/macOS only/g)).toHaveLength(5);
    const nativeLabel = [...container.querySelectorAll('span')].find((node) => node.textContent === 'Gemini (Symon & voice)')!;
    expect(nativeLabel.parentElement?.parentElement?.parentElement?.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('fails closed when native Keychain presence cannot be read', async () => {
  native.prefsReadFails = true;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(APIKeysTab)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Could not read desktop key status.');
    expect(container.textContent?.match(/unavailable/g)).toHaveLength(5);
    const nativeLabel = [...container.querySelectorAll('span')].find((node) => node.textContent === 'Gemini (Symon & voice)')!;
    expect(nativeLabel.parentElement?.parentElement?.parentElement?.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('shows an unavailable inventory error and retries the provider request', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ providers }) });
  vi.stubGlobal('fetch', fetchMock);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(APIKeysTab)); });
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('API key inventory returned 503.');
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'retry')!;
    await act(async () => { retry.click(); });
    expect(container.textContent).toContain('OpenRouter (app services)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});
