// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ model: '', write: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/tauri/bridge', () => ({
  isTauri: () => true,
  accessibilityPermissionGranted: async () => true,
  inputMonitoringGranted: async () => true,
  fnKeyUsageType: async () => 0,
  openSystemSettings: vi.fn(), openVoiceSettings: native.open,
  backgroundModeIsEnabled: async () => false, backgroundModeSet: vi.fn(),
  agentGetEscalation: async () => 'auto', agentSetEscalation: vi.fn(),
  voicePrefsGet: async () => ({}),
  voicePrefsSet: async (key: string, value: string) => { native.write(key, value); if (key === 'symon_brain_model') native.model = value; },
  externalKeyboardFnState: async () => null,
  symonBrainState: async () => ({
    provider: 'codex', tier: 'worker', model: native.model || null,
    adapters: [{ id: 'codex', label: 'Codex', installed: true, runtimeConfiguredModel: false }],
    resolvedProvider: 'codex', resolvedLabel: 'Codex', resolvedModel: native.model || 'gpt-5.6-terra',
    front: { choice: 'auto', options: [], resolvedId: 'codex', resolvedModel: native.model || 'gpt-5.6-terra' },
  }),
}));
vi.mock('./SymonAttentionSettingsSection', () => ({ SymonAttentionSettingsSection: () => null }));
import { VoiceTab } from './VoiceTab';

it('saves model choices through the Voice preference bridge, rereads them, and opens the separate Symon window', async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  native.model = '';
  native.write.mockClear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(VoiceTab)); });
    const select = container.querySelector('select')!;
    expect(select).not.toBeNull();
    await act(async () => { select.value = 'gpt-5.6-sol'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(native.write).toHaveBeenLastCalledWith('symon_brain_model', 'gpt-5.6-sol');
    expect(select.value).toBe('gpt-5.6-sol');
    expect(container.textContent).toContain('Background: Codex · gpt-5.6-sol');
    await act(async () => { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(native.model).toBe('');
    const entry = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Open Symon settings'))!;
    await act(async () => { entry.click(); });
    expect(native.open).toHaveBeenCalledOnce();
    expect(native.write.mock.calls.every(([key]) => key === 'symon_brain_model')).toBe(true);
  } finally { act(() => root.unmount()); container.remove(); }
});
