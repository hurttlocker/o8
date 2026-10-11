// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ account: 'account-a' as string | null }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => ({
  isLoaded: true, signedIn: Boolean(state.account), user: state.account ? { id: state.account } : null,
}) }));
import { PluginTaskReview } from './PluginTaskReview';

let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn();
const draft = { taskId: 'task-a', contractHash: 'hash-a', sessionCurrent: true, revision: 'revision-a', rulesDigest: 'rules-a',
  execution: null, executionError: null, contract: { objective: 'Read confidential fixture A', machineId: 'computer-a',
    repoId: 'repo-a', projectId: 'project-a', runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowedFiles: ['README.md'],
    evidence: ['Report totals'], sealedTaskContract: { version: 1, requirements: ['Read totals'] } } };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const list = (accountId = 'account-a') => response({ ok: true, accountId, drafts: accountId === 'account-a' ? [draft] : [] });
function button(text: string) { return [...container.querySelectorAll('button')].find((entry) => entry.textContent === text)!; }
async function render() { await act(async () => { root.render(createElement(PluginTaskReview)); }); }
async function click(text: string) { await act(async () => { button(text).click(); }); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.account = 'account-a';
  fetcher.mockReset().mockResolvedValue(list());
  vi.stubGlobal('fetch', fetcher);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('shows the exact contract and keeps a lost launch reply held until inspection', async () => {
  await render();
  expect(container.textContent).toContain('hash-a');
  expect(container.textContent).toContain('gpt-6.1-sol');
  fetcher.mockRejectedValueOnce(new Error('Connection lost'));
  await click('Launch reviewed task');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: 'launch', taskId: 'task-a', contractHash: 'hash-a' });
  expect(button('Launch reviewed task').disabled).toBe(true);
  await click('Refresh');
  expect(button('Launch reviewed task').disabled).toBe(true);
  const execution = { taskId: 'task-a', contractHash: 'hash-a', attemptId: 'attempt-a', state: 'running', stopped: false, completed: false };
  fetcher.mockResolvedValueOnce(response({ ok: true, execution }));
  await click('Inspect attempt');
  expect(container.textContent).toContain('attempt-a');
  expect(button('Launch reviewed task').disabled).toBe(true);
});

it('clears private details and ignores delayed list and control responses after account switches', async () => {
  await render();
  let resolveLaunch!: (value: unknown) => void;
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { resolveLaunch = resolve; }));
  await click('Launch reviewed task');
  state.account = 'account-b';
  fetcher.mockResolvedValueOnce(list('account-b'));
  await render();
  expect(container.textContent).not.toContain('confidential fixture A');
  await act(async () => { resolveLaunch(response({ ok: true, execution: { taskId: 'task-a', contractHash: 'hash-a', attemptId: 'attempt-a', state: 'running' } })); });
  expect(container.textContent).not.toContain('attempt-a');
  expect(button('Stop worker')).toBeUndefined();
  let resolveList!: (value: unknown) => void;
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve; }));
  state.account = 'account-a';
  await render();
  state.account = 'account-b';
  fetcher.mockResolvedValueOnce(list('account-b'));
  await render();
  await act(async () => { resolveList(list()); });
  expect(container.textContent).not.toContain('confidential fixture A');
});

it('keeps only an exact stop handle after sign-out and requires an explicit stop confirmation', async () => {
  await render();
  fetcher.mockRejectedValueOnce(new Error('Connection lost'));
  await click('Launch reviewed task');
  state.account = null;
  await render();
  expect(container.textContent).not.toContain('confidential fixture A');
  await click('Stop worker');
  expect(fetcher.mock.calls).toHaveLength(2);
  fetcher.mockResolvedValueOnce(response({ ok: true, execution: { taskId: 'task-a', contractHash: 'hash-a', attemptId: 'attempt-a', state: 'stopped', stopped: true } }));
  await click('Stop attempt');
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ action: 'stop', taskId: 'task-a', contractHash: 'hash-a' });
  expect(button('Stop worker')).toBeUndefined();
});

it('rejects a successful response belonging to a different account', async () => {
  fetcher.mockResolvedValueOnce(list('account-b'));
  await render();
  expect(container.textContent).not.toContain('confidential fixture A');
  expect(container.textContent).toContain('Tasks are held');
});


it('never stops a prior attempt while showing a different unlaunched task', async () => {
  const running = { ...draft, execution: { taskId: 'task-a', contractHash: 'hash-a', attemptId: 'attempt-a', state: 'running', stopped: false, completed: false } };
  fetcher.mockResolvedValueOnce(response({ ok: true, accountId: 'account-a', drafts: [running, { ...draft, taskId: 'task-b', contractHash: 'hash-b', contract: { ...draft.contract, objective: 'Read fixture B' } }] }));
  await render();
  expect(button('Stop worker')).toBeDefined();
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = 'task-b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(container.textContent).toContain('Read fixture B');
  expect(button('Stop worker')).toBeUndefined();
});

it('retains an exact Stop handle for a loaded running attempt after sign-out', async () => {
  const running = { ...draft, execution: { taskId: 'task-a', contractHash: 'hash-a', attemptId: 'attempt-a', state: 'running', stopped: false, completed: false } };
  fetcher.mockResolvedValueOnce(response({ ok: true, accountId: 'account-a', drafts: [running] }));
  await render();
  state.account = null;
  await render();
  expect(container.textContent).not.toContain('confidential fixture A');
  expect(container.textContent).toContain('Task task-a');
  await click('Stop worker');
  fetcher.mockResolvedValueOnce(response({ ok: true, execution: { taskId: 'task-a', contractHash: 'hash-a', attemptId: 'attempt-a', state: 'stopped', stopped: true } }));
  await click('Stop attempt');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: 'stop', taskId: 'task-a', contractHash: 'hash-a' });
});

it('keeps task selection fixed until the matching inspection response lands', async () => {
  const running = { ...draft, execution: { taskId: 'task-a', contractHash: 'hash-a', attemptId: 'attempt-a', state: 'running', stopped: false, completed: false } };
  fetcher.mockResolvedValueOnce(response({ ok: true, accountId: 'account-a', drafts: [running, { ...running, taskId: 'task-b', contractHash: 'hash-b' }] }));
  await render();
  let resolveInspect!: (value: unknown) => void;
  fetcher.mockImplementationOnce(() => new Promise((resolve) => { resolveInspect = resolve; }));
  await click('Inspect attempt');
  expect(container.querySelector('select')!.disabled).toBe(true);
  await act(async () => { resolveInspect(response({ ok: true, execution: { ...running.execution, state: 'completed', completed: true } })); });
  expect(button('Stop worker')).toBeUndefined();
  expect(container.querySelector('select')!.disabled).toBe(false);
});
