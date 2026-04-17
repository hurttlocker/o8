'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { ThoughtsOrchestratorBusyState } from '@/components/desktop/thoughts/chat-panel/types';

const USERS_THREE_ICON_PATH = 'M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1-7.37-4.89,8,8,0,0,1,0-6.22A8,8,0,0,1,192,112a24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.84,8,57,57,0,0,0-98.16,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}s`.replace('s', `:${seconds.toString().padStart(2, '0')}`);
}

function HeaderToggleButton({
  active,
  label,
  title,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        height: 44,
        paddingTop: 0,
        paddingRight: 14,
        paddingBottom: 0,
        paddingLeft: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-secondary)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: 'pointer',
        flexShrink: 0,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '-0.01em',
        transition: 'background 180ms ease, border-color 180ms ease, color 180ms ease',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.background = 'var(--t-bg-card)';
        event.currentTarget.style.borderColor = 'var(--t-border)';
        event.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.borderColor = 'var(--t-border)';
        event.currentTarget.style.color = 'var(--t-text-secondary)';
      }}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function ClockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function RocketIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function UsersThreeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d={USERS_THREE_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

function PlusIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function HeaderMetaChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'busy' }) {
  const busy = tone === 'busy';
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 36,
        paddingTop: 0,
        paddingRight: 12,
        paddingBottom: 0,
        paddingLeft: 12,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: busy ? 'rgba(249, 115, 22, 0.22)' : 'var(--t-border)',
        background: busy
          ? 'linear-gradient(180deg, rgba(249, 115, 22, 0.12), rgba(249, 115, 22, 0.05))'
          : 'var(--t-bg-card)',
        color: busy ? '#c2410c' : 'var(--t-text-secondary)',
        boxShadow: busy ? '0 10px 24px rgba(249, 115, 22, 0.10)' : 'none',
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

export function OrchestratorHeader({
  historyOpen,
  agentsOpen,
  missionOpen,
  hasMessages,
  messageCount,
  orchestratorBusyState,
  onToggleHistory,
  onToggleAgents,
  onToggleMission,
  onNewConversation,
}: {
  historyOpen: boolean;
  agentsOpen: boolean;
  missionOpen: boolean;
  hasMessages: boolean;
  messageCount: number;
  orchestratorBusyState: ThoughtsOrchestratorBusyState | null;
  onToggleHistory: () => void;
  onToggleAgents: () => void;
  onToggleMission: () => void;
  onNewConversation: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const busyActive = orchestratorBusyState?.active === true;

  useEffect(() => {
    if (!busyActive) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [busyActive]);

  const elapsedLabel = busyActive && orchestratorBusyState?.startedAt
    ? formatElapsed(now - orchestratorBusyState.startedAt)
    : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingTop: 10,
        paddingRight: 14,
        paddingBottom: 10,
        paddingLeft: 14,
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'var(--t-panel)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          flexWrap: 'wrap',
        }}
      >
        <HeaderToggleButton
          active={historyOpen}
          label="History"
          title={historyOpen ? 'Hide orchestrator history' : 'Show orchestrator history'}
          onClick={onToggleHistory}
        >
          <ClockIcon size={14} />
        </HeaderToggleButton>
        <HeaderToggleButton
          active={agentsOpen}
          label="Agents"
          title={agentsOpen ? 'Hide live agents' : 'Show live agents'}
          onClick={onToggleAgents}
        >
          <UsersThreeIcon size={14} />
        </HeaderToggleButton>
        <HeaderToggleButton
          active={missionOpen}
          label="Mission"
          title={missionOpen ? 'Hide Mission Control' : 'Show Mission Control'}
          onClick={onToggleMission}
        >
          <RocketIcon size={14} />
        </HeaderToggleButton>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 10,
          minWidth: 0,
          flexWrap: 'wrap',
        }}
      >
        {hasMessages ? (
          <HeaderMetaChip>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.02em' }}>
              {messageCount} {messageCount === 1 ? 'message' : 'messages'}
            </span>
          </HeaderMetaChip>
        ) : null}
        {busyActive && orchestratorBusyState ? (
          <HeaderMetaChip tone="busy">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#f97316',
                boxShadow: '0 0 0 5px rgba(249, 115, 22, 0.14)',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 11.5, fontWeight: 800, color: '#9a3412', letterSpacing: '-0.01em' }}>
              Orchestrator working
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#c2410c' }}>
              {orchestratorBusyState.toolCallsStarted} {orchestratorBusyState.toolCallsStarted === 1 ? 'tool call' : 'tool calls'}
            </span>
            {elapsedLabel ? (
              <span style={{ fontSize: 11, fontWeight: 700, color: '#ea580c', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                {elapsedLabel}
              </span>
            ) : null}
          </HeaderMetaChip>
        ) : null}
        {hasMessages ? (
          <button
            type="button"
            onClick={onNewConversation}
            aria-label="New orchestrator conversation"
            title="New orchestrator conversation"
            style={{
              height: 44,
              paddingTop: 0,
              paddingRight: 14,
              paddingBottom: 0,
              paddingLeft: 14,
              borderRadius: 14,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-border)',
              background: 'var(--t-bg-card)',
              color: 'var(--t-text-secondary)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              flexShrink: 0,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              transition: 'background 180ms ease, border-color 180ms ease, color 180ms ease',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = 'var(--t-panel)';
              event.currentTarget.style.borderColor = 'var(--t-border)';
              event.currentTarget.style.color = 'var(--t-text)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'var(--t-bg-card)';
              event.currentTarget.style.borderColor = 'var(--t-border)';
              event.currentTarget.style.color = 'var(--t-text-secondary)';
            }}
          >
            <PlusIcon size={13} />
            <span>New</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
