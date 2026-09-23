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
        />
      );
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Harness />));

    const project = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    expect(project?.textContent).toContain('Work in a project');
    expect(project?.disabled).toBe(false);
    act(() => project?.click());
    act(() => host?.querySelector<HTMLButtonElement>('[role="option"]')?.click());
    expect(onAddProject).toHaveBeenCalledOnce();

    act(() => host?.querySelector<HTMLButtonElement>('button[aria-label="Permissions: Full access"]')?.click());
    act(() => host?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="false"]')?.click());
    expect(onPermissionModeChange).toHaveBeenCalledWith('plan');
    expect(host.querySelector('[aria-label="Permissions: Plan only"]')).not.toBeNull();
  });
});
