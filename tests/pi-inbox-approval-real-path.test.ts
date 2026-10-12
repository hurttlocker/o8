// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { getDataDir } from '@/lib/data-dir-migration';
import { getRepoRegistryPath } from '@/lib/repos/registry';
import { createPiApproval } from '@/lib/pi/sdk/approval';
import { getApproval, listApprovals } from '@/lib/approvals/store';
import { GET, POST } from '@/app/api/panel/approvals/route';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { mintPacketWorkerToken } from '@/lib/auth/packet-worker-token';
import { O8InboxPane } from '@/components/desktop/O8InboxPane';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ requestRealtimeRefresh: vi.fn(async () => true), publishRealtimeMutation: vi.fn(async () => true) }));
const { requestRealtimeRefresh } = await import('@/lib/realtime/publisher');
const repo = '/fixture/pi-inbox';
let host: HTMLDivElement; let root: Root;
const running: Array<{ abort: AbortController; result: Promise<boolean> }> = [];
beforeAll(async () => {
  await writeFile(join(getDataDir(), 'projects.json'), JSON.stringify({ activeProjectId: 'other', projects: [
    { id: 'other', name: 'Other', repoPaths: ['/fixture/other'], createdAt: new Date().toISOString() },
  ] }));
  // A registered standalone repo is a virtual project, absent from the legacy ledger.
  await writeFile(getRepoRegistryPath(), JSON.stringify({ version: 1, repos: [
    { id: 'pi-inbox', name: 'pi-inbox', localPath: repo, addedAt: new Date().toISOString() },
  ] }));
});
beforeEach(() => {
  vi.mocked(requestRealtimeRefresh).mockClear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input.startsWith('/api/panel/approvals')) {
      const req = new NextRequest(`http://localhost${input}`, { ...init, signal: init?.signal ?? undefined, headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' } });
      return init?.method === 'POST' ? POST(req) : GET(req);
    }
    return Response.json({ items: [], maintainer: { replies: [], contributions: [], sources: [] } });
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  for (const turn of running.splice(0)) { turn.abort.abort(); await turn.result.catch(() => {}); }
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function pending(id: string, call: Parameters<ReturnType<typeof createPiApproval>>[0] = { name: 'run_command', args: { command: 'git status --short' } }) {
  const abort = new AbortController();
  const result = createPiApproval(id, repo)(call, abort.signal);
  void result.catch(() => {}); running.push({ abort, result });
  let approval: ReturnType<typeof getApproval>;
  await vi.waitFor(() => {
    approval = listApprovals({ status: 'pending', sessionKey: id, projectId: null })[0];
    expect(approval).toBeTruthy();
  });
  return { approval: approval!, result, abort };
}
const approvalsTab = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent?.startsWith('Approvals'))!;

describe('built-in agent approvals through Inbox', () => {
  it.each(['approve', 'reject'] as const)('shows another project’s approval and %ss it through the real route', async (action) => {
    const turn = await pending(`pi:inbox-${action}`);
    expect(turn.approval.projectId).toBe('repo:pi-inbox');
    expect(turn.approval.agent).toBe('o8');
    await act(async () => root.render(createElement(O8InboxPane, { active: true, repoPath: '/fixture/other' })));
    await act(async () => approvalsTab().click());
    expect(host.querySelector('details')?.textContent).toContain(repo);
    const label = action === 'approve' ? 'Approve' : 'Reject';
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
    expect(button, host.textContent ?? "").toBeTruthy();
    await act(async () => button!.click());
    expect(await turn.result).toBe(action === 'approve');
    expect(getApproval(turn.approval.id)?.status).toBe(action === 'approve' ? 'approved' : 'rejected');
    expect(host.textContent).not.toContain('git status --short');
  });
  it('shows the exact proposed file content before an operator decides', async () => {
    await pending('pi:inbox-write', { name: 'write_file', args: { path: 'notes.md', content: 'Updated release checklist' }, before: 'Previous checklist' });
    await act(async () => root.render(createElement(O8InboxPane, { active: true, repoPath: '/fixture/other' })));
    await act(async () => approvalsTab().click());
    const details = host.querySelector('details')!;
    details.open = true;
    expect(details.textContent).toContain('Proposed file content');
    expect(details.textContent).toContain('Updated release checklist');
  });
  it('keeps ordinary lists scoped and denies a worker the shared Inbox', async () => {
    const turn = await pending('pi:inbox-scopes');
    const headers = { authorization: `Bearer ${getOrCreateWsToken()}` };
    const scoped = await GET(new NextRequest('http://localhost/api/panel/approvals', { headers }));
    expect((await scoped.json()).approvals).toEqual([]);
    const all = await GET(new NextRequest('http://localhost/api/panel/approvals?scope=all', { headers }));
    expect((await all.json()).approvals.map((entry: { id: string }) => entry.id)).toContain(turn.approval.id);
    const worker = { authorization: `Bearer ${mintPacketWorkerToken('packet-own')}` };
    const denied = await GET(new NextRequest('http://localhost/api/panel/approvals?scope=all', { headers: worker }));
    expect(denied.status).toBe(403);
    const resolution = await POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST', headers: worker, body: JSON.stringify({ action: 'approve', id: turn.approval.id }) }));
    expect(resolution.status).toBe(403);
    expect(getApproval(turn.approval.id)?.status).toBe('pending');
  });
  it('remains pending after one minute, refreshes the open Inbox, and rejects on stop', async () => {
    const turn = await pending('pi:inbox-wait');
    expect(requestRealtimeRefresh).toHaveBeenCalled();
    const future = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(getApproval(turn.approval.id)?.status).toBe('pending');
    turn.abort.abort(); await turn.result.catch(() => {});
    expect(getApproval(turn.approval.id)?.status).toBe('rejected');
  });
  it('expires after the shared five-minute runtime approval window', async () => {
    const turn = await pending('pi:inbox-expiry');
    const future = Date.now() + 301_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    expect(await turn.result).toBe(false);
    expect(getApproval(turn.approval.id)?.status).toBe('rejected');
  });
});
