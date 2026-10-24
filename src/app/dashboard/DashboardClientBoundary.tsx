'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { WorkspaceBootLoader } from '@/components/desktop/workspace-terminal/WorkspaceBootLoader';

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Saved layout and tabs come from the browser. SSR needs only the boot cover.
 * Keep the page as an RSC child so Next still discovers its initial chunks,
 * while the browser mounts the same dashboard and restore logic.
 */
export function DashboardClientBoundary({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return mounted ? children : <WorkspaceBootLoader />;
}
