import type { CostsDashboardProps } from './types';

export function CostsDashboard({
  snapshot,
  onBack,
  onSessionSelect,
  compactLine,
}: CostsDashboardProps) {
  const openClawSessions = snapshot.sessions.filter(
    (session) => session.runtime === 'openclaw' && session.tokenUsage,
  );
  const totalTokens = openClawSessions.reduce((sum, session) => sum + (session.tokenUsage?.totalTokens ?? 0), 0);
  const totalRemaining = openClawSessions.reduce((sum, session) => sum + (session.tokenUsage?.remainingTokens ?? 0), 0);
  // Only compute capacity ratio if remainingTokens is actually reported
  const hasRemaining = openClawSessions.some((s) => (s.tokenUsage?.remainingTokens ?? 0) > 0);
  const totalCapacity = hasRemaining ? totalTokens + totalRemaining : 0;

  const byModel = new Map<string, { sessions: typeof openClawSessions; tokens: number; capacity: number }>();
  for (const session of openClawSessions) {
    const model = session.model ?? 'unknown';
    const existing = byModel.get(model) ?? { sessions: [], tokens: 0, capacity: 0 };
    existing.sessions.push(session);
    existing.tokens += session.tokenUsage?.totalTokens ?? 0;
    existing.capacity += (session.tokenUsage?.totalTokens ?? 0) + (session.tokenUsage?.remainingTokens ?? 0);
    byModel.set(model, existing);
  }

  const modelColor: Record<string, string> = {
    'claude-opus-4-6': '#ff3b30',
    'claude-sonnet-4-20250514': '#ff9f0a',
    'claude-haiku-4-5-20251001': '#34c759',
  };

  return (
    <div className="remodex-costs-view">
      <button
        type="button"
        className="remodex-costs-back"
        onClick={onBack}
      >
        ‹ Squad
      </button>

      <div className="remodex-costs-hero">
        <span className="remodex-costs-hero-kicker">Token Usage</span>
        <strong className="remodex-costs-hero-value">{totalTokens.toLocaleString()}</strong>
        <span className="remodex-costs-hero-sub">
          {totalCapacity.toLocaleString()} total capacity · {openClawSessions.length} active session{openClawSessions.length === 1 ? '' : 's'}
        </span>
        <div className="remodex-costs-hero-bar">
          <div
            className="remodex-costs-hero-fill"
            style={{ width: `${totalCapacity > 0 ? Math.round((totalTokens / totalCapacity) * 100) : 0}%` }}
          />
        </div>
      </div>

      <span className="remodex-costs-section-label">By Model</span>
      {Array.from(byModel.entries()).map(([model, data]) => {
        const percent = data.capacity > 0 ? Math.round((data.tokens / data.capacity) * 100) : 0;
        const color = modelColor[model] ?? '#6366f1';
        const shortModel = model.replace('claude-', '').replace(/-20\d{6}$/, '');
        return (
          <div key={model} className="remodex-costs-model-card">
            <div className="remodex-costs-model-head">
              <span className="remodex-costs-model-dot" style={{ background: color }} />
              <strong className="remodex-costs-model-name">{shortModel}</strong>
              <span className="remodex-costs-model-pct">{percent}%</span>
            </div>
            <div className="remodex-costs-model-bar">
              <div className="remodex-costs-model-fill" style={{ width: `${percent}%`, background: color }} />
            </div>
            <div className="remodex-costs-model-meta">
              <span>{data.tokens.toLocaleString()} tokens used</span>
              <span>{data.sessions.length} session{data.sessions.length === 1 ? '' : 's'}</span>
            </div>

            {data.sessions.map((session) => {
              const sessionPercent = session.context?.usedPercent ?? 0;
              const tone = sessionPercent >= 85 ? 'critical' : sessionPercent >= 75 ? 'high' : sessionPercent >= 65 ? 'watch' : 'calm';
              return (
                <button
                  key={session.id}
                  type="button"
                  className="remodex-costs-session-row"
                  onClick={() => onSessionSelect(session.id)}
                >
                  <span className={`remodex-costs-session-dot remodex-squad-dot-${tone}`} />
                  <span className="remodex-costs-session-name">{session.isCurrentSession ? 'This chat' : compactLine(session.name, 'Session', 28)}</span>
                  <span className="remodex-costs-session-tokens">{(session.tokenUsage?.totalTokens ?? 0).toLocaleString()}</span>
                  <span className="remodex-costs-session-pct">{sessionPercent}%</span>
                </button>
              );
            })}
          </div>
        );
      })}

      {(() => {
        const codexSessions = snapshot.sessions.filter((session) => session.runtime === 'codex');
        if (!codexSessions.length) {
          return null;
        }
        return (
          <div className="remodex-costs-model-card remodex-costs-model-card-muted">
            <div className="remodex-costs-model-head">
              <span className="remodex-costs-model-dot" style={{ background: '#6366f1' }} />
              <strong className="remodex-costs-model-name">Codex</strong>
              <span className="remodex-costs-model-pct">{codexSessions.length} session{codexSessions.length === 1 ? '' : 's'}</span>
            </div>
            <p className="remodex-costs-codex-note">Billed through ChatGPT Pro — token-level usage not available.</p>
          </div>
        );
      })()}
    </div>
  );
}
