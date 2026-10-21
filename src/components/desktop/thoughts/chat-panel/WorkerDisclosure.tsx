'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const WorkerDisclosureContext = createContext<{
  activeId: string | null;
  activate: (id: string) => void;
  deactivate: (id: string) => void;
} | null>(null);

/** One expanded worker surface per conversation; history and drafts stay mounted. */
export function WorkerDisclosureProvider({ children }: { children: ReactNode }) {
  const [activeId, activate] = useState<string | null>(null);
  const deactivate = useCallback((id: string) => activate(current => current === id ? null : current), []);
  const value = useMemo(() => ({ activeId, activate, deactivate }), [activeId, deactivate]);
  return <WorkerDisclosureContext.Provider value={value}>{children}</WorkerDisclosureContext.Provider>;
}

export function useWorkerDisclosure() {
  return useContext(WorkerDisclosureContext);
}
