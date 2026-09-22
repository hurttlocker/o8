/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PluginsTab from './PluginsTab';
import { CustomizeHeader } from './CustomizeHeader';
import { PROJECT_GUIDE } from '@/lib/customize/packages';

describe('plugin installation UI', () => {
  let host: HTMLDivElement;
  let root: Root;
  const requests = vi.fn();
  const changed = vi.fn();
  async function click(text: string) {
    const button = [...host.querySelectorAll<HTMLElement>('button, [role=button]')].find((entry) => entry.textContent?.includes(text));
    expect(button, `Missing button: ${text}`).toBeDefined();
    await act(async () => button?.click());
  }
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    changed.mockReset(); requests.mockReset(); vi.stubGlobal('fetch', requests);
    requests.mockResolvedValue({ ok: true, json: async () => ({ catalog: [PROJECT_GUIDE], installed: [] }) });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('requires content review before installation and keeps a failed install retryable', async () => {
    await act(async () => root.render(createElement(PluginsTab, { selectedRepo: '', onSelectRepo: vi.fn(), repos: [], onChanged: changed, onUseSkill: vi.fn() })));
    await click('Project guide');
    await click('Review installation');
    expect(requests).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(PROJECT_GUIDE.skills[0].instructions);
    requests.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: 'Storage is read-only.' } }) });
    await click('Install plugin');
    expect(host.textContent).toContain('Storage is read-only.');
    expect(changed).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Install plugin');
    requests.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    await click('Install plugin');
    expect(changed).toHaveBeenCalledOnce();
    expect(JSON.parse(requests.mock.calls[2][1].body)).toMatchObject({ repo: null, action: 'install', expectedRevision: null, manifest: PROJECT_GUIDE });
  });
  it('requires inline confirmation before removing an installed plugin', async () => {
    requests.mockResolvedValue({ ok: true, json: async () => ({ catalog: [PROJECT_GUIDE], installed: [{ manifest: PROJECT_GUIDE, revision: 'a'.repeat(64), enabled: true, files: [] }] }) });
    await act(async () => root.render(createElement(PluginsTab, { selectedRepo: '', onSelectRepo: vi.fn(), repos: [], onChanged: changed, onUseSkill: vi.fn() })));
    await click('Project guide'); await click('Remove plugin');
    expect(requests).toHaveBeenCalledTimes(1);
    await click('Cancel'); expect(requests).toHaveBeenCalledTimes(1);
    await click('Remove plugin'); await click('Confirm removal');
    expect(JSON.parse(requests.mock.calls[1][1].body)).toMatchObject({ action: 'remove', id: 'project-guide' });
  });
  it('keeps all customization sections and gates the plugin development surface', () => {
    const props = { tab: 'rules' as const, onTab: vi.fn(), query: '', onQuery: vi.fn(), repos: [], scope: 'all', onScope: vi.fn(), counts: {} };
    vi.stubEnv('NODE_ENV', 'production'); act(() => root.render(createElement(CustomizeHeader, props)));
    expect(host.textContent).not.toContain('Plugins');
    for (const label of ['Instructions', 'Commands', 'Prompts', 'Skills', 'Connections', 'Agents', 'Hooks']) expect(host.textContent).toContain(label);
    vi.stubEnv('NODE_ENV', 'development'); act(() => root.render(createElement(CustomizeHeader, props)));
    expect(host.textContent).toContain('Plugins');
  });
});
