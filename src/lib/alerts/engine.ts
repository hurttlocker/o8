/**
 * Alert detection engine — pure functions.
 *
 * Piggybacks on existing polling data (AgentSummary[]).
 * No new API calls, no side effects. Returns Alert[] for the provider to diff & merge.
 */

import type { AgentSummary } from '@/lib/fleet/types';
import type { Alert, AlertType } from './types';
import { TYPE_SEVERITY } from './types';

// ── Thresholds ──
const STUCK_MINUTES = 15;
const CONTEXT_WARN_PCT = 70;
const CONTEXT_CRITICAL_PCT = 85;
// Heartbeat intervals (minutes) — if no update in 2× interval, consider offline
const DEFAULT_HEARTBEAT_INTERVAL = 120; // 2h fallback

/** Parse "Xm ago" / "Xh ago" / "Xd ago" into minutes. Returns Infinity if unparseable. */
function parseAgeMinutes(ageStr: string | undefined): number {
  if (!ageStr) return Infinity;
  const m = ageStr.match(/(\d+)\s*(m|min|h|hr|d|day|s|sec)/i);
  if (!m) return Infinity;
  const val = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('s')) return val / 60;
  if (unit.startsWith('m')) return val;
  if (unit.startsWith('h')) return val * 60;
  if (unit.startsWith('d')) return val * 1440;
  return Infinity;
}

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
    const ageMinutes = parseAgeMinutes(agent.lastEventAt);
    const ctxPct = agent.context?.usedPercent ?? 0;

    // ── Approval needed ──
    if (agent.approvalStatus === 'pending') {
      alerts.push(
        makeAlert('approval', agent, `${agent.name} needs approval`, 'Waiting for human review', {
          actionable: true,
          actionLabel: 'Review',
        }),
      );
    }

    // ── Agent stuck (running but no activity) ──
    if (
      agent.status === 'running' &&
      ageMinutes >= STUCK_MINUTES &&
      agent.approvalStatus !== 'pending' // don't double-alert
    ) {
      alerts.push(
        makeAlert(
          'stuck',
          agent,
          `${agent.name} may be stuck`,
          `No activity for ${Math.round(ageMinutes)} minutes`,
          { actionable: true, actionLabel: 'Open' },
        ),
      );
    }

    // ── Agent errored ──
    if (agent.status === 'failed') {
      alerts.push(
        makeAlert('error', agent, `${agent.name} hit an error`, agent.currentTask || 'Unknown task', {
          actionable: true,
          actionLabel: 'View',
        }),
      );
    }

    // ── Context pressure ──
    if (ctxPct >= CONTEXT_CRITICAL_PCT) {
      alerts.push(
        makeAlert(
          'context-critical',
          agent,
          `${agent.name} context critical`,
          `${Math.round(ctxPct)}% used — compaction needed`,
          { actionable: true, actionLabel: 'Open' },
        ),
      );
    } else if (ctxPct >= CONTEXT_WARN_PCT) {
      alerts.push(
        makeAlert(
          'context-warn',
          agent,
          `${agent.name} context pressure`,
          `${Math.round(ctxPct)}% used`,
        ),
      );
    }

    // ── Agent offline (missed heartbeat) ──
    if (
      agent.status === 'idle' &&
      ageMinutes >= DEFAULT_HEARTBEAT_INTERVAL * 2 &&
      ageMinutes < Infinity
    ) {
      alerts.push(
        makeAlert('offline', agent, `${agent.name} offline`, `Last seen ${agent.lastEventAt}`),
      );
    }

    // ── Task completed ──
    // Detected by transition: we check if status is 'idle' with very recent activity
    // This is best handled by diffing previous state — will be wired in the context provider
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
