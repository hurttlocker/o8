// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { O8ThreadsPane } from './O8ThreadsPane';
import { ControlRoomTab } from '../repo-focus/tabs/ControlRoomTab';

const project = vi.hoisted(() => ({ id: 'project', name: 'Project', repoPaths: ['/repo', '/second'], createdAt: '2026-01-01T00:00:00.000Z' }));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => null }));
vi.mock('../repo-registry/useProjects', () => ({ useProjects: () => ({ activeProject: project, ledger: { projects: [project] }, loading: false }) }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));

const repos = ['/repo', '/second'].map((localPath, index) => ({ id: `repo-${index}`, name: `Repo ${index}`, localPath, defaultBranch: 'main', remoteUrl: null } as RepoRegistryEntry));
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

describe('New task dismissal through Threads', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetchMock = vi.fn(async (url: string) => json(url.includes('worker-availability')
      ? { available: true, connectedWorkers: 1, detail: '1 remote worker connected.' }
      : { tasks: [] }));
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  async function show() {
    await act(async () => root.render(createElement(O8ThreadsPane, { active: true, repoPath: null, repos, allRepos: true })));
  }
  function opener() { return container.querySelector<HTMLButtonElement>('[aria-label="Create thread"]')!; }
  function title() { return container.querySelector<HTMLInputElement>('input[placeholder="Task title"]'); }
  function button(label: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label); }
  async function open() {
    const source = opener();
    await act(async () => { source.focus(); source.click(); });
    expect(title()).not.toBeNull();
    return source;
  }
  function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function select(field: HTMLSelectElement, value: string) {
    act(() => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  function escape(target: Element, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options });
    act(() => { target.dispatchEvent(event); });
    return event;
  }
  function mutations() { return fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST'); }

  it('provides a labeled Cancel and returns focus to the actual header opener without writing', async () => {
    await show();
    const source = await open();
    const cancel = button('Cancel');
    expect(cancel).toBeDefined();
    expect(document.activeElement).toBe(title());
    act(() => { cancel!.focus(); cancel!.click(); });
    expect(title()).toBeNull();
    expect(document.activeElement).toBe(source);
    expect(mutations()).toHaveLength(0);
  });

  it('dismisses empty and populated drafts by Escape, Cancel and the original toggle consistently', async () => {
    await show();
    const source = await open();
    escape(title()!);
    expect(title()).toBeNull();
    expect(document.activeElement).toBe(source);
    await open();
    type(title()!, 'Synthetic draft');
    type(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Keep these constraints');
    const [repo, intent] = container.querySelectorAll<HTMLSelectElement>('select');
    select(repo, '/second'); select(intent, 'reviewer');
    for (const dismiss of ['escape', 'cancel', 'toggle']) {
      if (dismiss === 'escape') escape(title()!);
      else act(() => { (dismiss === 'cancel' ? button('Cancel')! : source).focus(); (dismiss === 'cancel' ? button('Cancel')! : source).click(); });
      expect(title()).toBeNull();
      expect(document.activeElement).toBe(source);
      await open();
      expect(title()!.value).toBe('Synthetic draft');
      expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep these constraints');
      const fields = container.querySelectorAll<HTMLSelectElement>('select');
      expect(fields[0].value).toBe('/second'); expect(fields[1].value).toBe('reviewer');
    }
    expect(mutations()).toHaveLength(0);
  });

  it('keeps the existing reset of placement/model/effort on reopen for each dismissal path', async () => {
    await show();
    for (const dismiss of ['escape', 'cancel', 'toggle']) {
      await open();
      select(container.querySelector<HTMLSelectElement>('[aria-label="Task execution location"]')!, 'cloud');
      select(container.querySelector<HTMLSelectElement>('[aria-label="Task model"]')!, 'gpt-6.1-sol');
      select(container.querySelector<HTMLSelectElement>('[aria-label="Task reasoning effort"]')!, 'medium');
      title()!.focus();
      if (dismiss === 'escape') escape(title()!);
      else act(() => (dismiss === 'cancel' ? button('Cancel')! : opener()).click());
      await open();
      expect(container.querySelector<HTMLSelectElement>('[aria-label="Task execution location"]')!.value).toBe('codex');
      expect(container.querySelector<HTMLSelectElement>('[aria-label="Task model"]')!.value).toBe('');
      expect(container.querySelector<HTMLSelectElement>('[aria-label="Task reasoning effort"]')!.value).toBe('adaptive');
      act(() => opener().click());
    }
    expect(mutations()).toHaveLength(0);
  });

  it('uses the real Control Room opener and preserves its parent draft across cancellation', async () => {
    await act(async () => root.render(createElement(ControlRoomTab, { project, repos })));
    const source = container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!;
    await act(async () => { source.focus(); source.click(); });
    type(title()!, 'Control Room draft');
    type(container.querySelector<HTMLTextAreaElement>('textarea')!, 'Keep this detail');
    title()!.focus(); escape(title()!);
    expect(title()).toBeNull(); expect(document.activeElement).toBe(source);
    await act(async () => source.click());
    expect(title()!.value).toBe('Control Room draft');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Keep this detail');
    act(() => { button('Cancel')!.focus(); button('Cancel')!.click(); });
    expect(title()).toBeNull(); expect(document.activeElement).toBe(source);
    expect(mutations()).toHaveLength(0);
  });

  it('keeps focus on intervening navigation, then returns to the original opener when cancelling the reopened draft', async () => {
    await show(); const source = await open(); type(title()!, 'Interrupted draft');
    act(() => { button('Agents')!.focus(); button('Agents')!.click(); });
    expect(title()).toBeNull(); expect(document.activeElement).toBe(button('Agents'));
    await act(async () => { button('Threads')!.focus(); button('Threads')!.click(); });
    expect(document.activeElement).toBe(button('Threads'));
    expect(title()!.value).toBe('Interrupted draft');
    title()!.focus(); escape(title()!);
    expect(title()).toBeNull(); expect(document.activeElement).toBe(source);
    expect(mutations()).toHaveLength(0);
  });

  it.each(['Add', 'Add + dispatch'])('protects the real Control Room toggle and Cancel during %s', async (action) => {
    await act(async () => root.render(createElement(ControlRoomTab, { project, repos })));
    const source = container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!;
    await act(async () => source.click()); type(title()!, 'Pending Control Room draft');
    let resolveCreate!: (response: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Promise<Response>((resolve) => { resolveCreate = resolve; })
      : Promise.resolve(json(url.includes('worker-availability') ? { available: true } : { tasks: [] })));
    act(() => button(action)!.click());
    expect(source.disabled).toBe(true); expect(button('Cancel')!.disabled).toBe(true);
    act(() => { source.click(); button('Cancel')!.click(); }); escape(title()!);
    expect(title()).not.toBeNull(); expect(mutations()).toHaveLength(1);
    await act(async () => resolveCreate(json({ ok: false, error: 'Synthetic refusal' }, 409)));
    expect(source.disabled).toBe(false); expect(button('Cancel')!.disabled).toBe(false);
    act(() => button('Cancel')!.click());
    expect(title()).toBeNull(); expect(document.activeElement).toBe(source);
    expect(mutations()).toHaveLength(1);
    expect(fetchMock.mock.calls.some((call) => call[0].includes('/dispatch'))).toBe(false);
  });

  it('leaves native selectors, composing input and child-owned Escape alone', async () => {
    await show(); await open();
    for (const field of container.querySelectorAll<HTMLSelectElement>('select')) {
      field.focus(); expect(escape(field).defaultPrevented).toBe(false); expect(title()).not.toBeNull();
    }
    title()!.focus();
    expect(escape(title()!, { isComposing: true }).defaultPrevented).toBe(false);
    expect(escape(title()!, { keyCode: 229 }).defaultPrevented).toBe(false);
    const consumed = (event: Event) => event.preventDefault();
    title()!.addEventListener('keydown', consumed);
    escape(title()!);
    title()!.removeEventListener('keydown', consumed);
    expect(title()).not.toBeNull();
    const menu = document.createElement('button'); menu.setAttribute('role', 'menuitem');
    const group = document.createElement('div'); group.setAttribute('role', 'menu'); group.append(menu);
    title()!.parentElement!.append(group);
    menu.focus(); expect(escape(menu).defaultPrevented).toBe(false);
    expect(title()).not.toBeNull();
    group.remove();
    expect(mutations()).toHaveLength(0);
  });

  it('does not steal Escape from a terminal outside the composer or retain a stale dismissal handler', async () => {
    await show(); await open();
    const terminal = document.createElement('textarea'); terminal.setAttribute('aria-label', 'Terminal'); container.append(terminal);
    terminal.focus(); expect(escape(terminal).defaultPrevented).toBe(false);
    expect(title()).not.toBeNull(); expect(document.activeElement).toBe(terminal);
    title()!.focus(); expect(escape(title()!).defaultPrevented).toBe(true);
    expect(title()).toBeNull();
    expect(escape(opener(), { repeat: true }).defaultPrevented).toBe(false);
    terminal.focus(); escape(terminal); expect(document.activeElement).toBe(terminal);
    expect(mutations()).toHaveLength(0);
  });

  it.each(['Add', 'Add + dispatch'])('cannot dismiss in-flight %s, then retains the failed draft for a cancel and retry', async (action) => {
    await show(); await open(); type(title()!, 'Retry this draft');
    let resolveCreate!: (response: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Promise<Response>((resolve) => { resolveCreate = resolve; })
      : Promise.resolve(json(url.includes('worker-availability') ? { available: true } : { tasks: [] })));
    act(() => button(action)!.click());
    expect(mutations()).toHaveLength(1);
    expect(button('Cancel')!.disabled).toBe(true);
    act(() => button('Cancel')!.click()); escape(title()!);
    expect(title()).not.toBeNull(); expect(opener().disabled).toBe(true);
    await act(async () => resolveCreate(json({ ok: false, error: 'Synthetic refusal' }, 409)));
    expect(container.textContent).toContain('Synthetic refusal');
    act(() => button('Cancel')!.click());
    expect(title()).toBeNull(); expect(document.activeElement).toBe(opener());
    await open(); expect(title()!.value).toBe('Retry this draft');
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => json(init?.method === 'POST' ? { ok: true, taskId: 'synthetic-task' } : { tasks: [] }));
    await act(async () => button('Add')!.click());
    expect(title()).toBeNull(); expect(mutations()).toHaveLength(2);
    expect(fetchMock.mock.calls.some((call) => call[0].includes('/dispatch'))).toBe(false);
    await open(); expect(title()!.value).toBe('');
  });
});
