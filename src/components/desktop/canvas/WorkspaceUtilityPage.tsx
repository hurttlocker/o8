'use client';

import { Suspense } from 'react';
import { retryingLazy } from '@/lib/react/retrying-lazy';
import { useWorkspaceUtilityContext } from './WorkspaceUtilityContext';
import type { WorkspaceUtilityKind } from './workspace-utility-navigation';

const Automations = retryingLazy(() => import('../AutomationsPage').then((m) => ({ default: m.AutomationsPage })), { label: 'Automations' });
const Customize = retryingLazy(() => import('../CustomizePage').then((m) => ({ default: m.CustomizePage })), { label: 'Customize' });

export function WorkspaceUtilityPage({ kind, projectId, onClose }: { kind: WorkspaceUtilityKind; projectId?: string; onClose: () => void }) {
  const context = useWorkspaceUtilityContext();
  const project = context?.projects.find((candidate) => candidate.id === projectId) ?? null;
  return <div data-workspace-utility={kind} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <Suspense fallback={<div role="status" style={{ padding: 28, color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 12 }}>Opening {kind}…</div>}>
      {kind === 'automations' ? <Automations currentOwner="operator" onClose={onClose} />
        : <Customize key={projectId ?? 'personal'} project={project} registeredRepos={context?.registeredRepos} onOpenPluginTerminal={context?.onOpenPluginTerminal} onClose={onClose} fixedTab={kind === 'plugins' ? 'plugins' : undefined} />}
    </Suspense>
  </div>;
}
