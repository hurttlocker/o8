// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerContextRow } from './ComposerContextRow';
import type { ThoughtsChatPermissionMode } from './types';

vi.mock('./ComposerPopover', async () => {
  const React = await import('react');
  return {
    ComposerPopover: ({ open, children }: { open: boolean; children: import('react').ReactNode }) => (
      open ? React.createElement('div', null, children) : null
    ),
  };
});

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('composer context row', () => {
  it('switches the next-send permission and keeps project setup reachable without targets', () => {
    const onPermissionModeChange = vi.fn();
    const onAddProject = vi.fn();
    function Harness() {
      const [mode, setMode] = useState<ThoughtsChatPermissionMode>('full');
      return (
        <ComposerContextRow
          selectedRepoPath="~"
          workspaceTargets={[]}
          onAddProject={onAddProject}
          permissionMode={mode}
          onPermissionModeChange={(next) => { setMode(next); onPermissionModeChange(next); }}
          contextLocationSlot={<span data-testid="context-location-slot" />}
        />
      );
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Harness />));

    const project = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    expect(project?.textContent).toContain('Project');
    expect(project?.getAttribute('aria-label')).toBe('Project target');
    expect(project?.disabled).toBe(false);
    act(() => project?.click());
    act(() => host?.querySelector<HTMLButtonElement>('[role="option"]')?.click());
    expect(onAddProject).toHaveBeenCalledOnce();

    act(() => host?.querySelector<HTMLButtonElement>('button[aria-label="Permissions: Full access"]')?.click());
    act(() => host?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="false"]')?.click());
    expect(onPermissionModeChange).toHaveBeenCalledWith('plan');
    expect(host.querySelector('[aria-label="Permissions: Plan only"]')).not.toBeNull();
  });

  it('names the selected repository as the project target', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(
      <ComposerContextRow
        repoLabel="o8"
        selectedRepoPath="/repo/o8"
        workspaceTargets={[]}
        onAddProject={() => {}}
      />,
    ));

    const project = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    expect(project?.textContent).toContain('o8');
    expect(project?.getAttribute('aria-label')).toBe('Project target: o8');
  });

  it('groups the left controls together and leaves the status slot on the row', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(
      <ComposerContextRow
        selectedRepoPath="~"
        workspaceTargets={[]}
        permissionMode="full"
        onPermissionModeChange={() => {}}
        contextLocationSlot={<span data-testid="context-location-slot" />}
      />,
    ));

    const row = host.querySelector('[data-o8-composer-context-row]');
    const controls = row?.querySelector('[data-o8-composer-context-controls]');
    const statusSlot = row?.querySelector('[data-o8-composer-status-slot]');

    expect(controls).not.toBeNull();
    expect(controls?.querySelector('button[aria-haspopup="listbox"]')).not.toBeNull();
    expect(controls?.querySelector('[data-testid="context-location-slot"]')).not.toBeNull();
    expect(controls?.querySelector('button[aria-haspopup="menu"]')).not.toBeNull();

    expect(statusSlot?.parentElement).toBe(row);
    expect(controls?.contains(statusSlot as Node)).toBe(false);
  });
});
