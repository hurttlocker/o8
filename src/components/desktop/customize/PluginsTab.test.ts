/** @vitest-environment jsdom */
import { act, createElement, useState } from 'react';
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
  it('retains a launched session when opening its view fails and retries opening without relaunch', async () => {
    const manifest = { id: 'console', name: 'Console', version: '1.0.0', description: 'Interactive', supportedPlatforms: ['darwin'], workspace: 'none', actions: [], terminals: [{ id: 'interactive', description: 'Type here', entry: 'run.sh', args: [] }] };
    const terminal = { id: 'launch-one', pluginId: 'console', terminalId: 'interactive', revision: 'a'.repeat(64), label: 'Console', sessionName: 'cortex-dash-test', workspaceRoot: null, status: 'running', exitCode: null, error: null };
    let launched = false;
    const onOpenTerminal = vi.fn().mockRejectedValueOnce(new Error('View unavailable')).mockResolvedValue(undefined);
    requests.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ installed: [{ manifest, revision: terminal.revision, enabled: true }], receipts: [], terminals: launched ? [terminal] : [] });
      const body = JSON.parse(String(init.body));
      if (body.action === 'stop-terminal') { terminal.status = 'stopped'; return Response.json({ terminal }); }
      expect(body).toMatchObject({ action: 'launch-terminal', id: 'console', terminalId: 'interactive', revision: terminal.revision });
      launched = true; return Response.json({ terminal });
    });
    await act(async () => root.render(createElement(PluginsTab, { onOpenTerminal })));
    await click('Launch terminal');
    expect(host.textContent).toContain('Use Open terminal to retry without starting another process.');
    await click('Open terminal');
    expect(onOpenTerminal).toHaveBeenCalledTimes(2);
    expect(requests.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    await click('Stop terminal'); await click('Cancel');
    expect(requests.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    await click('Stop terminal');
    expect(host.textContent).toContain('discard this terminal’s retained output');
    await click('Confirm stop');
    const posts = requests.mock.calls.filter((call) => call[1]?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[1][1].body)).toEqual({ action: 'stop-terminal', receiptId: terminal.id });
  });
  it('shows reviewed saved data and requires a separate confirmation to clear it', async () => {
    const state = { scope: 'source-and-project', environmentKey: 'O8_PLUGIN_STATE_DIR', namespace: 'b'.repeat(64), directory: '/owned/action-state/namespace' };
    const manifest = { id: 'counter', name: 'Counter', version: '1.0.0', description: 'Saved counter', supportedPlatforms: ['darwin'], workspace: 'none', state: { scope: 'source-and-project' }, actions: [] };
    const revision = 'a'.repeat(64);
    requests.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ installed: [{ manifest, revision, enabled: true, linkedAt: '', state }], receipts: [], damaged: [] });
      const body = JSON.parse(String(init.body));
      if (body.action === 'review') return Response.json({ review: { manifest, revision, files: [], execution: { cwd: '/owned/package', environmentKeys: ['PATH', 'NODE_ENV', 'O8_PLUGIN_STATE_DIR'], principal: 'local-user', state } } });
      return Response.json({ ok: true, cleared: true });
    });
    await act(async () => root.render(createElement(PluginsTab)));
    expect(host.textContent).toContain('Removal preserves this data.');
    const input = host.querySelector<HTMLInputElement>('#action-plugin-folder')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '/owned/source');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Review files');
    expect(host.textContent).toContain('O8_PLUGIN_STATE_DIR');
    expect(host.textContent).toContain('Created on the first run.');
    const before = requests.mock.calls.length;
    await click('Clear saved data'); expect(requests.mock.calls).toHaveLength(before);
    await click('Cancel'); expect(requests.mock.calls).toHaveLength(before);
    await click('Clear saved data'); await click('Confirm clear saved data');
    expect(JSON.parse(requests.mock.calls[before][1].body)).toEqual({ action: 'clear-state', id: 'counter', revision, confirmed: true });
    expect(host.textContent).toContain('saved data cleared.');
    requests.mockResolvedValueOnce(Response.json({ ok: true, cleared: true, cleanupPending: true }));
    await click('Clear saved data'); await click('Confirm clear saved data');
    expect(host.textContent).toContain('deleting the old files is still pending.');
    expect(host.textContent).not.toContain('saved data cleared.');
  });
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

  it('chooses a registered repository directly in Plugins and binds review, link and run to it', async () => {
    const manifest = { id: 'check', name: 'Check', version: '1.0.0', description: 'Check setup', supportedPlatforms: ['darwin'], workspace: 'registered-project', actions: [{ id: 'check', description: 'Check setup', entry: 'check.sh', args: [], timeoutMs: 5000 }] };
    const revision = 'c'.repeat(64);
    let installed: unknown[] = [];
    requests.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return Response.json({ installed, damaged: [], receipts: [] });
      const body = JSON.parse(String(init.body));
      if (body.action === 'review') return Response.json({ review: { manifest, revision, files: [], execution: { cwd: body.repo, environmentKeys: ['PATH'], principal: 'local-user' } } });
      if (body.action === 'link') installed = [{ manifest, revision, enabled: true, linkedAt: '', workspaceRoot: body.repo }];
      return Response.json({ receipt: { status: 'succeeded' } });
    });
    function Harness() {
      const [repoPath, onSelectRepo] = useState<string | null>(null);
      return createElement(PluginsTab, { repoPath, onSelectRepo, repos: [{ name: 'First repo', localPath: '/project/one' }, { name: 'Second repo', localPath: '/project/two' }] });
    }
    await act(async () => root.render(createElement(Harness)));
    await click('Choose repository');
    await click('Second repo');
    const input = host.querySelector<HTMLInputElement>('#action-plugin-folder')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '/plugins/check');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Review files');
    await click('Link reviewed revision');
    await click('Run');
    const commands = requests.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init.body)));
    expect(commands.map((body) => [body.action, body.repo])).toEqual([['review', '/project/two'], ['link', '/project/two'], ['invoke', '/project/two']]);
    await click('Second repo'); await click('First repo');
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Run')?.disabled).toBe(true);
  });

  it('hides a late repository review after the selection changes', async () => {
    let finishReview!: (value: Response) => void;
    requests.mockImplementation(async (_url: string, init?: RequestInit) => init?.method
      ? new Promise<Response>((resolve) => { finishReview = resolve; })
      : Response.json({ installed: [], damaged: [], receipts: [] }));
    await act(async () => root.render(createElement(PluginsTab, { repoPath: '/project/one' })));
    const input = host.querySelector<HTMLInputElement>('#action-plugin-folder')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '/plugins/check');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Review files');
    await act(async () => root.render(createElement(PluginsTab, { repoPath: '/project/two' })));
    await act(async () => finishReview(Response.json({ review: {
      manifest: { id: 'check', name: 'Check', workspace: 'registered-project' }, revision: 'd'.repeat(64), files: [], execution: { cwd: '/project/one' },
    } })));
    expect(host.textContent).not.toContain('Link reviewed revision');
    expect(host.textContent).not.toContain('d'.repeat(64));
  });

  it('reviews a pinned GitHub source and links only its returned staging folder without running it', async () => {
    const source = { kind: 'github', repository: 'test-owner/actions', commit: 'e'.repeat(40), directory: 'package' };
    const manifest = { id: 'source-check', name: 'Source check', version: '1.0.0', description: 'Source check', supportedPlatforms: ['darwin'], workspace: 'none', actions: [] };
    const revision = 'f'.repeat(64);
    requests.mockImplementation(async (_url: string, init?: RequestInit) => init?.method
      ? Response.json(JSON.parse(String(init.body)).action === 'review-github' ? { review: { source, sourceDirectory: '/owned/source-snapshot', manifest, revision, files: [], execution: { cwd: '/owned/installed', environmentKeys: ['PATH'], principal: 'local-user' } } } : { ok: true })
      : Response.json({ installed: [], damaged: [], receipts: [] }));
    await act(async () => root.render(createElement(PluginsTab)));
    await click('GitHub source');
    const fill = async (label: string, value: string) => act(async () => {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await fill('Public GitHub repository', source.repository);
    await fill('Exact commit', source.commit);
    await fill('Package directory (optional)', source.directory);
    expect(requests).toHaveBeenCalledTimes(1);
    await click('Review files');
    expect(host.textContent).toContain(`GitHub: ${source.repository} @ ${source.commit} / package`);
    await fill('Exact commit', '1'.repeat(40));
    expect(host.textContent).not.toContain('Link reviewed revision');
    await click('Review files');
    await click('Link reviewed revision');
    const commands = requests.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init.body)));
    expect(commands[0]).toEqual({ action: 'review-github', repository: source.repository, commit: source.commit, directory: 'package' });
    expect(commands[2]).toEqual({ action: 'link', directory: '/owned/source-snapshot', expectedRevision: revision });
    expect(commands.map((entry) => entry.action)).toEqual(['review-github', 'review-github', 'link']);
  });
});
