// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CustomizePage } from '../CustomizePage';
import { ContextRecallCard } from '../thoughts/ContextRecallCard';
import { RecallHealthSection } from '../settings/RecallHealthSection';
import { setCustomizeTab } from './navigation';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root, fail: boolean;
let directives: Array<{ id: string; title: string; scope: string; body: string; repoName: null; projects: string[]; file: string }>;
let outcomes: Array<{ id: string; summary: string; outcome: string; runtime: string; completedAt: string }>;
const deleted: Array<{ path: string; body: Record<string, unknown> }> = [];
const timing = { totalSamples: 0, windowedSamples: 0, windowMs: 1, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, errorCount: 0, byLabel: [] };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label)!;
const click = async (label: string) => { expect(button(label), label).toBeTruthy(); await act(async () => { button(label).click(); await new Promise(resolve => setTimeout(resolve, 300)); }); };
beforeEach(async () => {
  localStorage.clear(); setCustomizeTab('rules'); fail = false; deleted.length = 0;
  directives = ['remove', 'keep'].map(id => ({ id, title: `${id} instruction`, scope: 'global', body: `${id} guidance`, repoName: null, projects: [], file: `/fixture/directives/${id}.md` }));
  outcomes = ['remove', 'keep'].map(id => ({ id, summary: `${id} outcome`, outcome: 'succeeded', runtime: 'codex', completedAt: new Date().toISOString() }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0];
    if (init?.method === 'DELETE') {
      if (fail) return Response.json({ error: 'Fixture delete refused' }, { status: 503 });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; deleted.push({ path, body });
      if (path.endsWith('/directives')) directives = directives.filter(d => d.id !== body.id);
      else outcomes = outcomes.filter(o => o.id !== body.id);
      return Response.json({ ok: true });
    }
    if (path === '/api/cortex/directives') return Response.json({ directives });
    if (path === '/api/cortex/recent-outcomes') return Response.json({ outcomes });
    if (path === '/api/cortex/diagnostics') return Response.json({ outcomesCount: outcomes.length, directivesCount: directives.length, timing, timing7d: timing, thresholds: { outcomesEval: 5000, p95Ms: 100, sustainedDays: 7 }, health: 'green', notes: [] });
    if (path === '/api/customize/inventory') return Response.json({ ok: true, skills: [], agents: [], hooks: [] });
    if (path === '/api/setup/mcp-servers') return Response.json({ servers: [] });
    if (path === '/api/cortex/project-pulse') return Response.json({ pulses: [] });
    return Response.json({ entries: [] });
  }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(createElement(Fragment, null,
    createElement(CustomizePage), createElement(ContextRecallCard, { packet: { workspaceTargetPath: '/fixture/repo', title: 'Fixture' } as OrchestratorPacket, repoName: null }), createElement(RecallHealthSection),
  )); });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('confirms only the selected directive and refreshes Customize, recall and health counts', async () => {
  await act(async () => host.querySelector<HTMLElement>('[role="button"]')!.click());
  await click('Delete instruction remove instruction');
  expect(deleted).toEqual([]);
  await click('Cancel'); expect(deleted).toEqual([]);
  await click('Delete instruction remove instruction'); await click('Delete');
  expect(deleted).toEqual([{ path: '/api/cortex/directives', body: { id: 'remove' } }]);
  expect(host.textContent).not.toContain('remove instruction');
  expect(host.textContent).toContain('keep instruction');
  expect(host.textContent).toContain('1 authored instruction');
  const counter = [...host.querySelectorAll('span')].find(s => s.textContent === 'Directives count')!.parentElement!;
  expect(counter.textContent).toContain('1');
});
it('keeps a failed outcome delete visible, then removes only that outcome after retry', async () => {
  const recent = [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('recent'))!;
  await act(async () => recent.click());
  await click('Delete outcome remove outcome'); fail = true; await click('Delete');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Fixture delete refused');
  expect(host.textContent).toContain('remove outcome'); expect(deleted).toEqual([]);
  fail = false; await click('Delete');
  expect(deleted).toEqual([{ path: '/api/cortex/recent-outcomes', body: { id: 'remove', repoPath: '/fixture/repo' } }]);
  expect(host.textContent).not.toContain('remove outcome'); expect(host.textContent).toContain('keep outcome');
  const counter = [...host.querySelectorAll('span')].find(s => s.textContent === 'Outcomes count')!.parentElement!;
  expect(counter.textContent).toContain('1');
});
