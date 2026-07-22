import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { isTauri } from '@/lib/tauri/bridge';

export interface AgentConfirmation {
  confirmationId: string;
  taskId: string;
  tool: string;
  summary: string;
  kind?: 'action' | 'plan';
  plan?: AgentConfirmationPlan;
}

export interface AgentConfirmationPlan {
  planId: string;
  steps: AgentPlanStep[];
}

export interface AgentPlanStep {
  index: number;
  summary: string;
}

function parsePlanSteps(value: unknown): AgentPlanStep[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) return undefined;
  const steps: AgentPlanStep[] = [];
  for (const [offset, step] of value.entries()) {
    if (!step || typeof step !== 'object') return undefined;
    const candidate = step as { index?: unknown; summary?: unknown };
    const summary = typeof candidate.summary === 'string' ? candidate.summary.trim() : '';
    if (!summary || candidate.index !== offset + 1) return undefined;
    steps.push({ index: offset + 1, summary });
  }
  return steps;
}

export function parseConfirmationPlan(value: unknown): AgentConfirmationPlan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { planId?: unknown; steps?: unknown };
  const planId = typeof candidate.planId === 'string' ? candidate.planId.trim() : '';
  const steps = parsePlanSteps(candidate.steps);
  return planId && steps ? { planId, steps } : undefined;
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
        const kind = payload?.kind === 'plan' ? 'plan' : undefined;
        const plan = parseConfirmationPlan(payload?.plan);
        log(`agent-confirm ${tool}`);
        if (confirmationId && taskId) {
          if (kind === 'plan' && !plan) {
            log(`agent-confirm rejected malformed plan ${confirmationId}`);
            return;
          }
          setConfirmation({
            confirmationId,
            taskId,
            tool,
            summary,
            ...(kind === 'plan' && plan ? { kind, plan } : {}),
          });
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
