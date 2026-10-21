// @vitest-environment jsdom
import { act, createElement, forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextualConversation } from '../thoughts/chat-panel/contextual-turn';
import type { MaintainerContribution } from '@/lib/inbox/maintainer-types';
import { contextualTurnMessage } from '../thoughts/chat-panel/contextual-turn';
import { maintainerReplyDraft } from '@/lib/inbox/maintainer-draft';
import { MaintainerThreadCard } from './MaintainerThreadCard';
import { useMaintainerReplyChat } from './MaintainerReplyChat';

const loaded = vi.hoisted(() => ({ threads: [] as string[], contexts: [] as string[], reportBusy: undefined as ((busy: boolean) => void) | undefined }));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => ({ agents: [], missionState: { packets: [] }, workspaceTargets: [], onMissionStateChange() {} }) }));
vi.mock('../thoughts/ThoughtsChatPanel', () => ({ ThoughtsChatPanel: forwardRef(function FakeChat({ contextualConversation: context, open }: { contextualConversation: ContextualConversation; open: boolean }, ref) {
  const [draft, setDraft] = useState(context.initialDraft ?? '');
  useImperativeHandle(ref, () => ({ focusInput() {}, loadThread(id: string) { loaded.threads.push(id); } }));
  useEffect(() => { context.onDraftChange?.(draft); }, [context, draft]);
  useEffect(() => { loaded.contexts.push(context.requestContext); }, [context.requestContext]);
  useEffect(() => { loaded.reportBusy = context.onBusyChange; }, [context.onBusyChange]);
  return createElement('textarea', { 'aria-label': 'Reply draft', value: draft, hidden: !open, onChange: (event) => setDraft((event.target as HTMLTextAreaElement).value) });
}) }));
const thread = (number: number): MaintainerContribution => ({ id: `reply:${number}`, kind: 'reply', repo: 'example/repo', repoPaths: ['/workspace/repo'], number, title: `Contributor question ${number}`, author: 'contributor', assignees: [], url: `https://github.com/example/repo/issues/${number}`, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', threadKind: 'issue' });
function Harness({ active = true }: { active?: boolean }) {
  const chat = useMaintainerReplyChat(active);
  return createElement('main', null, ...[1, 2].map((number) => createElement(MaintainerThreadCard, { key: number, source: thread(number), onPrepareReply: chat.prepare })), chat.conversation);
}
let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.stubGlobal('fetch', vi.fn()); loaded.threads = []; loaded.contexts = []; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const open = (number = 1) => act(async () => host.querySelector<HTMLButtonElement>(`[data-maintainer-thread="reply:${number}"] button`)!.click());
const draft = () => host.querySelector<HTMLTextAreaElement>('[aria-label="Reply draft"]')!;
const change = (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft(), value); draft().dispatchEvent(new Event('input', { bubbles: true })); });
describe('contextual maintainer replies', () => {
  it('opens a floating orchestrator with concise editable text and no automatic send or GitHub settlement', async () => {
    await act(async () => root.render(createElement(Harness))); await open();
    await vi.waitFor(() => expect(draft()).toBeTruthy());
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toContain('Issue #1');
    expect(draft().value).toBe('Help me draft a reply.');
    expect(loaded.contexts[0]).toContain(thread(1).url); expect(loaded.contexts[0]).toContain('wait for their explicit approval');
    expect(fetch).not.toHaveBeenCalled(); expect(host.textContent).toContain('Open');
  });
  it('retains a draft when closed, hidden, and switched to another GitHub thread', async () => {
    await act(async () => root.render(createElement(Harness))); await open();
    await vi.waitFor(() => expect(draft()).toBeTruthy()); await change('Please mention the reproduction.');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close reply conversation"]')!.click());
    await open(); expect(draft().value).toBe('Please mention the reproduction.');
    await act(async () => root.render(createElement(Harness, { active: false })));
    expect(host.querySelector('[role="dialog"]')!.getAttribute('inert')).not.toBeNull();
    await act(async () => root.render(createElement(Harness))); expect(draft().value).toBe('Please mention the reproduction.');
    await open(2); expect(draft().value).toBe('Help me draft a reply.');
    await open(1); expect(draft().value).toBe('Please mention the reproduction.');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses malformed source links and attaches metadata without replacing the user message', () => {
    expect(maintainerReplyDraft({ ...thread(1), url: 'javascript:alert(1)' })).toBeNull();
    const context = maintainerReplyDraft(thread(1))!;
    expect(contextualTurnMessage('Explain the proposed fix.', context.requestContext)).toMatch(/^Explain the proposed fix\.\n\n/);
    expect(context.requestContext).toContain(JSON.stringify({ url: thread(1).url, title: thread(1).title }));
  });
  it('keeps a running reply conversation available until its turn finishes', async () => {
    await act(async () => root.render(createElement(Harness))); await open();
    await vi.waitFor(() => expect(draft()).toBeTruthy());
    await act(async () => loaded.reportBusy?.(true)); await open(2);
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toContain('Issue #1');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('still running');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close reply conversation"]')!.click());
    await open(1);
    await act(async () => loaded.reportBusy?.(false)); await open(2);
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toContain('Issue #2');
  });
});
