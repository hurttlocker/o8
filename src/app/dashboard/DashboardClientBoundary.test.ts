// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import DashboardLayout from './layout';

vi.mock('@/components/desktop/workspace-terminal/WorkspaceBootLoader', () => ({
  WorkspaceBootLoader: () => createElement('div', { 'aria-label': 'Loading workspace' }),
}));

it('hydrates the cover and mounts the workspace once, retaining its tab and draft on rerender', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let mounts = 0;
  function SavedWorkspace({ label }: { label: string }) {
    const [tab, setTab] = useState('saved-tab');
    const [draft, setDraft] = useState('unsent draft');
    useEffect(() => { mounts++; }, []);
    return createElement('div', { 'data-tab': tab }, label,
      createElement('button', { onClick: () => setTab('second-tab') }, 'Switch tab'),
      createElement('input', { value: draft, onChange: event => setDraft(event.target.value) }));
  }
  const layout = (label: string) => createElement(DashboardLayout, null, createElement(SavedWorkspace, { label }));
  const host = document.createElement('div');
  document.body.append(host);
  host.innerHTML = renderToString(layout('Restored'));
  expect(host.querySelector('[aria-label="Loading workspace"]')).not.toBeNull();
  const errors: unknown[] = [];
  let root: Root | undefined;
  try {
    await act(async () => { root = hydrateRoot(host, layout('Restored'), { onRecoverableError: error => errors.push(error) }); });
    expect(host.querySelector('[data-tab="saved-tab"]')).not.toBeNull();
    await act(async () => host.querySelector('button')!.click());
    await act(async () => root!.render(layout('Updated')));
    expect(host.querySelector('[data-tab="second-tab"]')).not.toBeNull();
    expect(host.querySelector('input')?.value).toBe('unsent draft');
    expect(mounts).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await act(async () => root?.unmount());
    host.remove();
  }
});
