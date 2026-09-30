/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PluginsTab from './PluginsTab';
import InstructionBundlesPanel from './InstructionBundlesPanel';
import { CustomizeHeader } from './CustomizeHeader';
import { PROJECT_GUIDE } from '@/lib/customize/packages';

describe('Customize extension views', () => {
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
    await act(async () => root.render(createElement(InstructionBundlesPanel, { selectedRepo: '', onSelectRepo: vi.fn(), repos: [], onChanged: changed, onUseSkill: vi.fn() })));
    await click('Manage bundles');
    await click('Project guide');
    await click('Review installation');
    expect(requests).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(PROJECT_GUIDE.skills[0].instructions);
    requests.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: 'Storage is read-only.' } }) });
    await click('Install bundle');
    expect(host.textContent).toContain('Storage is read-only.');
    expect(changed).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Install bundle');
    requests.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    await click('Install bundle');
    expect(changed).toHaveBeenCalledOnce();
    expect(JSON.parse(requests.mock.calls[2][1].body)).toMatchObject({ repo: null, action: 'install', expectedRevision: null, manifest: PROJECT_GUIDE });
  });
  it('requires inline confirmation before removing an installed bundle', async () => {
    requests.mockResolvedValue({ ok: true, json: async () => ({ catalog: [PROJECT_GUIDE], installed: [{ manifest: PROJECT_GUIDE, revision: 'a'.repeat(64), enabled: true, files: [] }] }) });
    await act(async () => root.render(createElement(InstructionBundlesPanel, { selectedRepo: '', onSelectRepo: vi.fn(), repos: [], onChanged: changed, onUseSkill: vi.fn() })));
    await click('Manage bundles');
    await click('Project guide'); await click('Remove bundle');
    expect(requests).toHaveBeenCalledTimes(1);
    await click('Cancel'); expect(requests).toHaveBeenCalledTimes(1);
    await click('Remove bundle'); await click('Confirm removal');
    expect(JSON.parse(requests.mock.calls[1][1].body)).toMatchObject({ action: 'remove', id: 'project-guide' });
  });
  it('keeps Plugins separate from Skills in production', async () => {
    const props = { tab: 'rules' as const, onTab: vi.fn(), query: '', onQuery: vi.fn(), repos: [], scope: 'all', onScope: vi.fn(), counts: {} };
    vi.stubEnv('NODE_ENV', 'production'); act(() => root.render(createElement(CustomizeHeader, props)));
    expect(host.textContent).toContain('Plugins');
    for (const label of ['Instructions', 'Commands', 'Prompts', 'Skills', 'Connections', 'Agents', 'Hooks']) expect(host.textContent).toContain(label);
    vi.stubEnv('NODE_ENV', 'development'); act(() => root.render(createElement(CustomizeHeader, props)));
    expect(host.textContent).toContain('Plugins');
    await act(async () => root.render(createElement(PluginsTab)));
    expect(host.textContent).toContain('Action plugins');
    expect(host.textContent).toContain('Instruction bundles remain in Skills.');
    expect(host.textContent).not.toContain('Install location');
    expect(host.textContent).not.toContain('Bundle format');
  });

  it('reviews an exact revision before linking and runs only an enabled action', async () => {
    const manifest = {
      id: 'sample-action', name: 'Sample action', version: '1.0.0', description: 'Check a local project',
      supportedPlatforms: ['darwin'], workspace: 'none',
      actions: [{ id: 'check', description: 'Check setup', entry: 'run.sh', args: [], timeoutMs: 5000 }],
    };
    const revision = 'a'.repeat(64);
    const installed: Array<{ manifest: typeof manifest; revision: string; enabled: boolean; linkedAt: string }> = [];
    const receipts: Array<{ id: string; plugin_id: string; action_id: string; status: string; started_at: string; exit_code: number; stdout: string; stderr: string; error: null }> = [];
    requests.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return { ok: true, json: async () => ({ installed, damaged: [], receipts }) };
      const body = JSON.parse(String(init.body)) as { action: string; directory?: string };
      if (body.action === 'review') return { ok: true, json: async () => ({ review: { manifest, revision, files: [{ path: 'run.sh', bytes: 40, sha256: 'b'.repeat(64), content: '#!/bin/sh\nprintf "ready\\n"\n' }], execution: { cwd: '/tmp/installed/sample-action', environmentKeys: ['PATH', 'NODE_ENV'], principal: 'local-user' } } }) };
      if (body.action === 'link') installed.push({ manifest, revision, enabled: true, linkedAt: new Date(0).toISOString() });
      if (body.action === 'disable') installed[0].enabled = false;
      if (body.action === 'invoke') receipts.push({ id: 'receipt-1', plugin_id: manifest.id, action_id: 'check', status: 'succeeded', started_at: new Date(0).toISOString(), exit_code: 0, stdout: 'ready', stderr: '', error: null });
      return { ok: true, json: async () => body.action === 'invoke' ? { receipt: { status: 'succeeded' } } : { ok: true } };
    });
    await act(async () => root.render(createElement(PluginsTab)));
    const input = host.querySelector<HTMLInputElement>('#action-plugin-folder')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '/tmp/sample-action');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Review files');
    expect(host.textContent).toContain(revision);
    expect(host.textContent).toContain('run.sh (40 bytes)');
    expect(host.textContent).toContain('b'.repeat(64));
    expect(host.textContent).toContain('printf "ready');
    expect(host.textContent).toContain('/tmp/installed/sample-action');
    expect(host.textContent).toContain('PATH, NODE_ENV');
    await click('Link reviewed revision');
    expect(requests.mock.calls.some(([, init]) => init?.method === 'POST' && JSON.parse(String(init.body)).expectedRevision === revision)).toBe(true);
    await click('Run');
    expect(host.textContent).toContain('Recent runs');
    expect(host.textContent).toContain('succeeded');
    await click('Disable');
    expect(host.textContent).toContain('Disabled');
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Run')?.disabled).toBe(true);
    expect(requests.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init.body)).action)).toEqual(['review', 'link', 'invoke', 'disable']);
  });

  it('does not offer a project-bound action in another selected project', async () => {
    const manifest = {
      id: 'project-check', name: 'Project check', version: '1.0.0', description: 'Check a project',
      supportedPlatforms: ['darwin'], workspace: 'registered-project',
      actions: [{ id: 'check', description: 'Check setup', entry: 'run.sh', args: [], timeoutMs: 5000 }],
    };
    requests.mockResolvedValue({ ok: true, json: async () => ({ installed: [{ manifest, revision: 'a'.repeat(64), enabled: true, linkedAt: new Date(0).toISOString(), workspaceRoot: '/project/one' }], damaged: [], receipts: [] }) });
    await act(async () => root.render(createElement(PluginsTab, { repoPath: '/project/two' })));
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Run')?.disabled).toBe(true);
    await act(async () => root.render(createElement(PluginsTab, { repoPath: '/project/one' })));
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Run')?.disabled).toBe(false);
  });
});
