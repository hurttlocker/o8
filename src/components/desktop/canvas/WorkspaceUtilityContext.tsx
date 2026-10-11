'use client';

import { createContext, useContext } from 'react';
import type { ProjectRecord } from '../repo-registry/useProjects';
import type { CustomizeRepo } from '../customize/inventory';

export interface WorkspaceUtilityContextValue {
  projects: ProjectRecord[];
  registeredRepos: CustomizeRepo[];
  onOpenPluginTerminal: (terminal: { sessionName: string; label: string; workspaceRoot: string | null }) => Promise<void>;
}

const Context = createContext<WorkspaceUtilityContextValue | null>(null);
export const WorkspaceUtilityProvider = Context.Provider;
export function useWorkspaceUtilityContext() { return useContext(Context); }
