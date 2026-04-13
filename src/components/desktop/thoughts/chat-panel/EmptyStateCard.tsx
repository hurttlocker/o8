'use client';

import type { AgentTarget } from '../types';

interface Suggestion {
  text: string;
  action: string;
  agent: AgentTarget;
  priority?: 'critical' | 'warn' | 'info';
}

interface EmptyStateCardProps {
  isOrchestratorMode: boolean;
  targetAgent: AgentTarget | null;
  activeTargetLabel: string;
  activeTargetColor: string;
  thoughtsElevatedSurface: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
  suggestions: Suggestion[];
  onSelectSuggestion: (suggestion: Suggestion) => void;
}

export function EmptyStateCard({
  isOrchestratorMode,
  targetAgent,
  activeTargetLabel,
  activeTargetColor,
  thoughtsElevatedSurface,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
  suggestions,
  onSelectSuggestion,
}: EmptyStateCardProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 1,
      gap: 12,
      padding: '20px 0',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 340,
        padding: '16px 18px',
        borderRadius: 18,
        background: thoughtsElevatedSurface,
        border: thoughtsElevatedBorder,
        boxShadow: thoughtsElevatedShadow,
        textAlign: 'left',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: activeTargetColor,
            boxShadow: `0 0 0 4px ${activeTargetColor}18`,
          }} />
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}>
            {activeTargetLabel}
          </span>
          <span style={{
            marginLeft: 'auto',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--t-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            Live Chat
          </span>
        </div>
        <div style={{
          fontSize: 12,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.6,
          marginBottom: 10,
        }}>
          {isOrchestratorMode
            ? 'Claude Code is your orchestrator. Your first message spawns a live session with full agent capabilities.'
            : 'Intervene directly with a live Codex or Claude Code lane without leaving the planner surface.'}
        </div>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontSize: 11,
          color: 'var(--t-text-secondary)',
        }}>
          {isOrchestratorMode ? (
            <>
              <div>Full Claude Code agent — reads files, writes code, runs commands, manages lanes.</div>
              <div>Same experience as your terminal. Use the picker below to switch targets.</div>
            </>
          ) : targetAgent ? (
            <>
              <div>Messages stay scoped to the selected CLI lane.</div>
              <div>Use the picker below to redirect the conversation to another live session.</div>
              <div>Mission Control now slides out beside chat, so planning stays visible without replacing this lane.</div>
            </>
          ) : (
            <>
              <div>No live Codex or Claude Code lane is available right now.</div>
              <div>Switch to Claude orchestrator or launch a CLI lane from a workspace tab.</div>
            </>
          )}
        </div>
      </div>

      {suggestions.length > 0 ? (
        <div style={{ width: '100%', maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{
            fontSize: 9,
            fontWeight: 700,
            textTransform: 'uppercase',
            color: 'var(--t-text-muted)',
            letterSpacing: '0.05em',
            padding: '0 2px',
          }}>
            Suggested
          </div>
          {suggestions.map((suggestion, index) => (
            <button
              key={index}
              type="button"
              onClick={() => onSelectSuggestion(suggestion)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                borderRadius: 10,
                textAlign: 'left',
                border: '1px solid var(--t-divider)',
                background: 'var(--t-hover)',
                cursor: 'pointer',
              }}
            >
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                flexShrink: 0,
                background: suggestion.priority === 'critical' ? '#ef4444' : suggestion.priority === 'warn' ? '#f59e0b' : 'var(--t-text-muted)',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--t-text)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {suggestion.text}
                </div>
                <div style={{ fontSize: 9, color: 'var(--t-text-muted)', marginTop: 1 }}>
                  → {suggestion.agent.name}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
