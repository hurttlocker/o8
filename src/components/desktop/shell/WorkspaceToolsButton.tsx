'use client';

import { useEffect, useState } from 'react';
import { HeaderIconPill } from './HeaderIconPill';

export const WORKSPACE_TOOLS_TOGGLE = 'o8:request-workspace-tools';
export const WORKSPACE_TOOLS_STATE = 'o8:workspace-tools-state';

/** The active workspace owns the popover; the header only routes its trigger. */
export function WorkspaceToolsButton({ workspaceId }: { workspaceId?: string | null }) {
  const owner = workspaceId ?? '';
  const [state, setState] = useState({ owner: '', open: false });
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; open: boolean }>).detail;
      if (detail?.workspaceId === owner) setState({ owner, open: detail.open });
    };
    window.addEventListener(WORKSPACE_TOOLS_STATE, update);
    return () => window.removeEventListener(WORKSPACE_TOOLS_STATE, update);
  }, [owner]);
  return <div data-workspace-tools-owner={owner} style={{ display: 'inline-flex', flexShrink: 0 }}>
    <HeaderIconPill label="Workspace tools" expanded={state.owner === owner && state.open} popup="dialog" yNudge={1.3}
      onClick={() => window.dispatchEvent(new CustomEvent(WORKSPACE_TOOLS_TOGGLE, { detail: { workspaceId: owner } }))}
      icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <circle cx="5" cy="7" r="2.5" /><circle cx="5" cy="17" r="2.5" /><path d="M11 7h10M11 17h10" />
      </svg>} />
  </div>;
}
