// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const receipt = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestrator/action-receipt', () => ({ fetchCorrelatedActionReceipt: receipt }));
import { PrCheckRepair } from './PrCheckRepair';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sha = 'a'.repeat(40);
let root: Root; let container: HTMLDivElement; let pr = 6;
const snapshot = { ok: true, headSha: sha, checks: [{ key: '1', name: 'Unit tests' }, { key: '2', name: 'Lint' }] };
const delegation = { clientMutationId: 'prepared-id', repoPath: '/fixture', prompt: 'fix', repairPullRequest: 7, expectedRepairHeadSha: sha };
async function render(failed = true) { await act(async () => root.render(createElement(PrCheckRepair, { repo: 'fixture/repo', number: pr, failed }))); }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === label);
  expect(button, container.textContent ?? '').toBeDefined(); await act(async () => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  pr += 1; sessionStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => Response.json(init?.method === 'POST' ? { ok: true, delegation } : snapshot)));
  receipt.mockResolvedValue({ response: new Response(), payload: { ok: true, laneId: 'lane-repair', packetId: 'pkt-repair' } });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
describe('repair selected failing checks', () => {
  it('shows the action only for failures', async () => {
    await render(false); expect(container.textContent).toBe('');
    await render(); expect(container.textContent).toContain('Fix failing checks');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('selects checks, prepares their head-bound evidence and launches the normal delegate', async () => {
    await render(); await click('Fix failing checks');
    expect(container.querySelectorAll('input[type=checkbox]')).toHaveLength(2);
    await act(async () => (container.querySelectorAll('input')[1] as HTMLInputElement).click());
    await click('Start repair');
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toMatchObject({ expectedHeadSha: sha, checks: ['1'] });
    expect(receipt).toHaveBeenCalledWith('/api/orchestrator/delegate', expect.objectContaining({ method: 'POST', body: JSON.stringify(delegation) }));
    expect(container.textContent).toContain('Repair worker started');
  });
  it.each(['stale_pr_head', 'stale_checks'])('requires refreshed selection after %s', async code => {
    await render(); await click('Fix failing checks');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, code, error: 'Checks changed. Refresh checks.' }, { status: 409 }));
    await click('Start repair');
    expect(container.textContent).toContain('Refresh checks'); expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(receipt).not.toHaveBeenCalled();
  });
  it('defers an owned PR and offers the existing worker', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ok: false, code: 'pr_has_owner', ownerLaneId: 'lane-existing', error: 'Send checks to the owning worker.' }, { status: 409 }));
    await render(); await click('Fix failing checks');
    expect(container.textContent).toContain('owning worker'); expect(container.textContent).toContain('Open owning worker');
    expect(receipt).not.toHaveBeenCalled();
  });
  it('retains the exact launch body after an uncertain receipt and remount', async () => {
    receipt.mockRejectedValueOnce(new Error('receipt unavailable'));
    await render(); await click('Fix failing checks'); await click('Start repair');
    const original = receipt.mock.calls[0][1].body;
    await act(async () => root.unmount()); root = createRoot(container); await render();
    await click('Check repair receipt');
    expect(receipt.mock.calls[1][1].body).toBe(original);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Repair worker started');
  });

  it('shares preparation and its mutation identity across simultaneous copies of the same PR', async () => {
    await act(async () => root.render(createElement('div', {},
      createElement(PrCheckRepair, { repo: 'fixture/repo', number: pr, failed: true }),
      createElement(PrCheckRepair, { repo: 'fixture/repo', number: pr, failed: true }))));
    await act(async () => { for (const button of [...container.querySelectorAll('button')]) button.click(); });
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const starts = [...container.querySelectorAll('button')].filter(button => button.textContent === 'Start repair');
    await act(async () => { starts[0].click(); starts[1].click(); });
    expect(fetch).toHaveBeenCalledTimes(3); // two selection reads, one preparation
    await act(async () => finish(Response.json({ ok: true, delegation })));
    expect(receipt).toHaveBeenCalledTimes(1);
  });
});
