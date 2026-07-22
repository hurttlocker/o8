import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { isTauri } from '@/lib/tauri/bridge';

export interface AgentConfirmation {
  confirmationId: string;
  taskId: string;
  tool: string;
  summary: string;
}

export function useAgentConfirmations(
  log: (message: string) => void,
): [AgentConfirmation | null, Dispatch<SetStateAction<AgentConfirmation | null>>] {
  const state = useState<AgentConfirmation | null>(null);
  const [, setConfirmation] = state;

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const offs: Array<() => void> = [];
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const add = (unlisten: () => void) => {
        if (disposed) unlisten();
        else offs.push(unlisten);
      };
      add(await listen<Partial<AgentConfirmation>>('o8:agent-confirm', ({ payload }) => {
        const confirmationId = payload?.confirmationId ?? '';
        const taskId = payload?.taskId ?? '';
        const tool = payload?.tool ?? '';
        const summary = payload?.summary ?? 'Run this action?';
        log(`agent-confirm ${tool}`);
        if (confirmationId && taskId) {
          setConfirmation({ confirmationId, taskId, tool, summary });
        }
      }));
      add(await listen<Partial<AgentConfirmation>>(
        'o8:agent-confirm-dismissed',
        ({ payload }) => setConfirmation((current) => (
          current
          && current.confirmationId === payload?.confirmationId
          && current.taskId === payload?.taskId
            ? null
            : current
        )),
      ));
    }).catch((error) => {
      log(`agent confirmation subscribe failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return () => {
      disposed = true;
      for (const off of offs) off();
    };
  }, [log, setConfirmation]);

  return state;
}
