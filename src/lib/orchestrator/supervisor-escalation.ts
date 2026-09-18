/**
 * Supervisor escalation to an orchestrator turn, moved out of the ws-server so
 * the real path is reachable from tests (#2467). Behaviour is unchanged; the
 * ws-server passes its auto-message enqueue.
 */
import { resolveSupervisorAutoEscalateSync } from '@/lib/operator/defaults';
import { escalationSessionKey, startWakeTriage } from '@/lib/orchestrator/wake-triage';

export function queueOrchestratorEscalation(
  repoPath: string,
  message: string,
  enqueue: (repoPath: string, message: string, label: string) => void,
): void {
  // Supervisor escalations spawn fresh orchestrator turns into the user's
  // chat — that's how codex agent narrative + bash runs end up bleeding into
  // the orchestrator transcript. Default OFF: supervisor failures surface via
  // lane status + activity feed instead, leaving the chat clean.
  // Set O8_SUPERVISOR_AUTO_ESCALATE=1 (or flip Settings → Dispatch &
  // Supervision → Auto-escalate) to restore the old auto-investigation.
  if (!resolveSupervisorAutoEscalateSync()) {
    console.log(`[supervisor] Escalation suppressed (auto-escalate disabled): ${repoPath} — ${message.slice(0, 80)}`);
    return;
  }
  startWakeTriage({ source: 'supervisor-escalation', sessionKey: escalationSessionKey(message) });
  enqueue(repoPath, message, 'escalation');
}
