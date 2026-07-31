'use client';

import { useEffect } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import type { SymonTextPlannerSelection } from '@/lib/mobile/symon-text-eval';

interface SymonTextPlannerInfo {
  available: boolean;
  engine?: 'claude' | 'codex';
  model?: string;
  effort?: string;
  tools?: Array<Record<string, unknown>>;
  detail?: string;
}

interface SymonTextTurnResult {
  status: 'done' | 'interrupted';
  text: string;
}

interface SymonTextBridge {
  plannerInfo: (selection?: SymonTextPlannerSelection) => Promise<SymonTextPlannerInfo>;
  runTurn: (
    prompt: string,
    sessionId: string,
    turnId: string,
    planner: SymonTextPlannerSelection,
  ) => Promise<SymonTextTurnResult>;
  interruptTurn: (sessionId: string, turnId: string) => Promise<boolean>;
}

type AgentWindow = Window & {
  __o8SymonAgent?: Record<string, unknown> & { text?: SymonTextBridge };
};

/** Adds the subscription-CLI text seat to the existing Symon webview bridge. */
export function SymonTextBridgeHost() {
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let attachedTo: AgentWindow['__o8SymonAgent'];
    let bridge: SymonTextBridge | null = null;

    void import('@tauri-apps/api/core').then(({ invoke }) => {
      if (!alive) return;
      bridge = {
        plannerInfo: (selection) => invoke<SymonTextPlannerInfo>('symon_text_planner_info', selection ? {
          engine: selection.engine,
          model: selection.model,
          effort: selection.effort,
        } : {}),
        runTurn: (prompt, sessionId, turnId, planner) => invoke<SymonTextTurnResult>('symon_text_run_turn', {
          prompt,
          sessionId,
          turnId,
          engine: planner.engine,
          model: planner.model,
          effort: planner.effort,
        }),
        interruptTurn: (sessionId, turnId) => invoke<boolean>('symon_text_interrupt', {
          sessionId,
          turnId,
        }),
      };
    }).catch((error) => console.warn('[symon-text] bridge unavailable:', error));

    const timer = window.setInterval(() => {
      const agent = (window as AgentWindow).__o8SymonAgent;
      if (!agent || !bridge || agent === attachedTo) return;
      agent.text = bridge;
      attachedTo = agent;
      console.log('[symon-text] planner bridge ready');
    }, 100);

    return () => {
      alive = false;
      window.clearInterval(timer);
      if (attachedTo?.text === bridge) delete attachedTo.text;
    };
  }, []);

  return null;
}
