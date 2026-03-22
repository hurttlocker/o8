/**
 * Alert detection engine — pure functions.
 *
 * Piggybacks on existing polling data (AgentSummary[]).
 * No new API calls, no side effects. Returns Alert[] for the provider to diff & merge.
 * Keep this high-signal only: surface explicit problems, not speculative noise.
 */

import type { AgentSummary } from '@/lib/fleet/types';
import type { Alert, AlertType } from './types';
import { TYPE_SEVERITY } from './types';

function makeId(type: AlertType, agentId: string): string {
  return `${type}:${agentId}`;
}

function makeAlert(
  type: AlertType,
  agent: AgentSummary,
  title: string,
  detail: string,
  opts?: { actionable?: boolean; actionLabel?: string },
): Alert {
  return {
    id: makeId(type, agent.id),
    type,
    severity: TYPE_SEVERITY[type],
    agentId: agent.id,
    agentName: agent.name,
    title,
    detail,
    timestamp: Date.now(),
    read: false,
    dismissed: false,
    actionable: opts?.actionable ?? false,
    actionLabel: opts?.actionLabel,
    sessionKey: agent.sessionKey,
  };
}

/**
 * Detect alerts from current agent state.
 * Returns a fresh list — caller is responsible for merging with existing alerts.
 */
export function detectAlerts(agents: AgentSummary[]): Alert[] {
  const alerts: Alert[] = [];

  for (const agent of agents) {
    // Only surface explicit approval gates.
    if (agent.approvalStatus === 'pending') {
      alerts.push(
        makeAlert('approval', agent, `${agent.name} needs approval`, 'Waiting for human review', {
          actionable: true,
          actionLabel: 'Review',
        }),
      );
    }

    // Surface only concrete failures or blocked runs, not inferred "stuck" states.
    if (agent.status === 'failed' || agent.status === 'blocked') {
      const title = agent.status === 'blocked'
        ? `${agent.name} is blocked`
        : `${agent.name} hit an error`;
      alerts.push(
        makeAlert(
          'error',
          agent,
          title,
          agent.currentTask || 'Review the latest runtime output',
          {
            actionable: true,
            actionLabel: 'Open',
          },
        ),
      );
    }
  }

  return alerts;
}

/**
 * Merge newly detected alerts with existing state.
 * - New alerts get added
 * - Existing alerts that are no longer detected get auto-dismissed
 * - Dismissed/read state is preserved for alerts that persist
 */
export function mergeAlerts(existing: Alert[], detected: Alert[]): Alert[] {
  const detectedMap = new Map(detected.map((a) => [a.id, a]));
  const existingMap = new Map(existing.map((a) => [a.id, a]));

  const merged: Alert[] = [];

  // Keep detected alerts, preserving read/dismissed state from existing
  for (const alert of detected) {
    const prev = existingMap.get(alert.id);
    if (prev) {
      // Preserve user interaction state, update detail/timestamp
      merged.push({
        ...alert,
        read: prev.read,
        dismissed: prev.dismissed,
        // Keep original timestamp if same alert persists
        timestamp: prev.timestamp,
      });
    } else {
      merged.push(alert);
    }
  }

  // Auto-dismiss alerts that are no longer detected (keep for 60s then drop)
  for (const alert of existing) {
    if (!detectedMap.has(alert.id) && !alert.dismissed) {
      const age = Date.now() - alert.timestamp;
      if (age < 60_000) {
        // Recently cleared — show as resolved briefly
        merged.push({ ...alert, dismissed: true });
      }
      // Older than 60s and no longer detected → drop entirely
    }
  }

  return merged;
}
