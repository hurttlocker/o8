import { ChevronRight } from 'lucide-react';
import type { SquadRailProps } from './types';

export function SquadRail({
  projectGroups,
  expandedProject,
  selectedSession,
  onSessionFocus,
  onProjectToggle,
  onCostsView,
  agentDisplayName,
}: SquadRailProps) {
  void onCostsView;

  if (!projectGroups.length) {
    return null;
  }

  return (
    <div className="remodex-squad-rail">
      {projectGroups.map((group) => {
        const isExpanded = expandedProject === group.workspace;
        const contextPercent = Math.round(group.bestContextPct);
        const contextTone = contextPercent >= 85 ? 'critical' : contextPercent >= 75 ? 'high' : contextPercent >= 65 ? 'watch' : 'calm';
        const containsSelected = group.sessions.some((session) => session.id === selectedSession?.id);
        const isSingleAgent = group.sessions.length === 1;

        const handleProjectTap = () => {
          if (isSingleAgent) {
            onSessionFocus(group.sessions[0].id);
            return;
          }
          onProjectToggle(isExpanded ? null : group.workspace);
        };

        return (
          <div key={group.workspace} className="remodex-project-group">
            <button
              type="button"
              className={`remodex-squad-card remodex-project-card ${containsSelected ? 'remodex-squad-card-active' : ''} ${isExpanded ? 'remodex-project-card-expanded' : ''}`}
              onClick={handleProjectTap}
            >
              <div className="remodex-squad-card-head">
                <span className={`remodex-squad-dot ${group.hasRunning ? 'remodex-squad-dot-live' : ''} remodex-squad-dot-${contextTone}`} />
                <strong className="remodex-squad-name">{group.projectName}</strong>
                <span className="remodex-squad-time">{group.mostRecentTime ?? 'idle'}</span>
              </div>
              <span className="remodex-project-summary">{group.summary}</span>
              {!isSingleAgent ? (
                <ChevronRight size={11} className={`remodex-project-chevron ${isExpanded ? 'remodex-project-chevron-open' : ''}`} />
              ) : null}
            </button>

            {isExpanded && !isSingleAgent ? (
              <div className="remodex-project-agents">
                {group.sessions.map((session) => {
                  const active = session.id === selectedSession?.id;
                  const isRunning = session.status === 'running' || session.status === 'reviewing';
                  const sessionPercent = Math.round(session.context?.usedPercent ?? 0);
                  const sessionTone = sessionPercent >= 85 ? 'critical' : sessionPercent >= 75 ? 'high' : sessionPercent >= 65 ? 'watch' : 'calm';
                  const name = agentDisplayName(session);
                  const branchShort = session.branch?.replace(/^(feat|fix|batch|chore|refactor)\//, '') ?? '';
                  const statusLabel = session.runtime === 'codex' && branchShort
                    ? branchShort
                    : (session.activity?.headline ?? session.status);
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className={`remodex-agent-pill ${active ? 'remodex-agent-pill-active' : ''}`}
                      onClick={() => onSessionFocus(session.id)}
                    >
                      <span className={`remodex-squad-dot ${isRunning ? 'remodex-squad-dot-live' : ''} remodex-squad-dot-${sessionTone}`} />
                      <span className="remodex-agent-pill-name">{name}</span>
                      <span className="remodex-agent-pill-sep">·</span>
                      <span className="remodex-agent-pill-status">{statusLabel}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
