'use client';

import { memo, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import {
  ChevronRight,
  FolderOpen,
  MessageSquare,
  Radio,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { CLI_AGENTS, THEME_ACCENT, THEME_ACCENT_SOFT } from '@/components/desktop/workspace-terminal/constants';
import { AgentDot, PhosphorPlay } from '@/components/desktop/workspace-terminal/icons';
import { CodexIcon, ClaudeIcon } from '@/components/desktop/repo-registry/shared';
import type { RegisteredRepo } from '@/components/desktop/workspace-terminal/types';

interface WorkspaceLaunchPickerProps {
  launchRequestKey?: number;
  scopedRepo?: RegisteredRepo | null;
  onRegisterRepo?: (localPath: string) => void;
  onNewTab: (agentId: string, repo?: RegisteredRepo) => void;
  onNewChatTab: (runtime: 'codex' | 'claude-code', repo?: RegisteredRepo) => void;
  onNewLLMChatTab: (repo?: RegisteredRepo) => void;
}

function WorkspaceLaunchPickerBase({
  launchRequestKey,
  scopedRepo,
  onRegisterRepo,
  onNewTab,
  onNewChatTab,
  onNewLLMChatTab,
}: WorkspaceLaunchPickerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStep, setPickerStep] = useState<'main' | 'terminal' | 'session' | 'repo'>('main');
  const [selectedAgent, setSelectedAgent] = useState<(typeof CLI_AGENTS)[number] | null>(null);
  const [repos, setRepos] = useState<RegisteredRepo[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);

  const openLaunchPicker = () => {
    setSelectedAgent(null);
    setPickerStep('main');
    setPickerOpen(true);
  };

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const handler = (event: globalThis.MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
        setPickerStep('main');
        setSelectedAgent(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  useEffect(() => {
    if (launchRequestKey) {
      openLaunchPicker();
    }
  }, [launchRequestKey]);

  useEffect(() => {
    if (!pickerOpen) return;
    fetch('/api/panel/repos')
      .then((response) => response.json())
      .then((data) => setRepos(data.repos ?? []))
      .catch(() => setRepos([]));
  }, [pickerOpen]);

  return (
    <div ref={pickerRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => {
          if (pickerOpen) {
            setPickerOpen(false);
            setPickerStep('main');
            setSelectedAgent(null);
            return;
          }
          openLaunchPicker();
        }}
        aria-label="Launch agent"
        title="Launch agent"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          marginTop: 4,
          marginRight: 8,
          borderRadius: 7,
          border: 'none',
          background: pickerOpen ? THEME_ACCENT_SOFT : 'transparent',
          color: THEME_ACCENT,
          cursor: 'pointer',
          flexShrink: 0,
          boxShadow: 'none',
          transition: 'background 100ms, color 100ms',
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = THEME_ACCENT_SOFT;
        }}
        onMouseLeave={(event) => {
          if (!pickerOpen) {
            event.currentTarget.style.background = 'transparent';
          }
        }}
      >
        <PhosphorPlay size={13} />
      </button>

      {pickerOpen ? (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            zIndex: 9000,
            marginTop: 4,
            minWidth: 220,
            background: '#1e2028',
            backdropFilter: 'none',
            WebkitBackdropFilter: 'none',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 10,
            overflow: 'hidden',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.28), 0 1px 3px rgba(0, 0, 0, 0.15)',
          } as CSSProperties}
        >
          {pickerStep === 'main' ? (
            <>
              <button
                type="button"
                onClick={() => {
                  onNewLLMChatTab(scopedRepo ?? undefined);
                  setPickerOpen(false);
                  setPickerStep('main');
                }}
                style={menuButtonStyle}
                onMouseEnter={highlightOn}
                onMouseLeave={resetOn}
              >
                <span style={iconSlotStyle}>
                  <MessageSquare size={14} style={{ color: THEME_ACCENT }} />
                </span>
                <div>
                  <div style={{ fontWeight: 500 }}>New Chat</div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Direct LLM conversation</div>
                </div>
              </button>

              <div style={{ height: 1, background: 'var(--t-divider)' }} />

              <button
                type="button"
                onClick={() => setPickerStep('terminal')}
                style={menuButtonStyle}
                onMouseEnter={highlightOn}
                onMouseLeave={resetOn}
              >
                <span style={iconSlotStyle}>
                  <TerminalIcon size={14} style={{ color: 'var(--t-text-secondary)' }} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>CLI Terminal</div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Shell or agent CLI</div>
                </div>
                <ChevronRight size={12} style={{ color: 'var(--t-text-muted)' }} />
              </button>

              <button
                type="button"
                onClick={() => setPickerStep('session')}
                style={menuButtonStyle}
                onMouseEnter={highlightOn}
                onMouseLeave={resetOn}
              >
                <span style={iconSlotStyle}>
                  <Radio size={14} style={{ color: '#8b5cf6' }} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>CLI Session</div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Agent conversation</div>
                </div>
                <ChevronRight size={12} style={{ color: 'var(--t-text-muted)' }} />
              </button>
            </>
          ) : null}

          {pickerStep === 'terminal' ? (
            <>
              <button type="button" onClick={() => setPickerStep('main')} style={backButtonStyle}>
                Back to CLI Terminal
              </button>
              {CLI_AGENTS.map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  onClick={() => {
                    if (scopedRepo) {
                      onNewTab(agent.id, scopedRepo);
                      setPickerOpen(false);
                      setPickerStep('main');
                      return;
                    }
                    if (agent.id === 'shell') {
                      onNewTab(agent.id);
                      setPickerOpen(false);
                      setPickerStep('main');
                      return;
                    }
                    setSelectedAgent(agent);
                    setPickerStep('repo');
                  }}
                  style={submenuButtonStyle}
                  onMouseEnter={hoverOn}
                  onMouseLeave={hoverOff}
                >
                  <span style={iconSlotStyle}>
                    {agent.id === 'shell' ? (
                      <TerminalIcon size={14} style={{ color: 'var(--t-text-muted)' }} />
                    ) : agent.id === 'claude' ? (
                      <ClaudeIcon size={18} />
                    ) : agent.id === 'codex' ? (
                      <CodexIcon size={18} />
                    ) : (
                      <AgentDot color={agent.color} size={10} />
                    )}
                  </span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{agent.label}</div>
                    {agent.command ? (
                      <div style={{ fontSize: 11, color: 'var(--t-text-faint)', fontFamily: 'ui-monospace, monospace' }}>
                        $ {agent.command}
                      </div>
                    ) : null}
                  </div>
                </button>
              ))}
            </>
          ) : null}

          {pickerStep === 'session' ? (
            <>
              <button type="button" onClick={() => setPickerStep('main')} style={backButtonStyle}>
                Back to CLI Session
              </button>
              {([
                { id: 'codex' as const, label: 'Codex', color: '#10b981' },
                { id: 'claude-code' as const, label: 'Claude Code', color: '#8b5cf6' },
              ]).map((runtime) => (
                <button
                  type="button"
                  key={runtime.id}
                  onClick={() => {
                    onNewChatTab(runtime.id, scopedRepo ?? undefined);
                    setPickerOpen(false);
                    setPickerStep('main');
                  }}
                  style={submenuButtonStyle}
                  onMouseEnter={hoverOn}
                  onMouseLeave={hoverOff}
                >
                  <span style={iconSlotStyle}>
                    {runtime.id === 'claude-code'
                      ? <ClaudeIcon size={18} />
                      : <CodexIcon size={18} />}
                  </span>
                  <div>
                    <div style={{ fontWeight: 500 }}>{runtime.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--t-text-faint)' }}>Agent conversation</div>
                  </div>
                </button>
              ))}
            </>
          ) : null}

          {pickerStep === 'repo' && selectedAgent ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setPickerStep('terminal');
                  setSelectedAgent(null);
                }}
                style={backButtonStyle}
              >
                Back to {selectedAgent.label}
              </button>
              <div style={sectionLabelStyle}>Select Repo</div>

              <button
                type="button"
                onClick={() => {
                  onNewTab(selectedAgent.id);
                  setPickerOpen(false);
                  setPickerStep('terminal');
                  setSelectedAgent(null);
                }}
                style={submenuButtonStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
              >
                <TerminalIcon size={14} style={{ color: 'var(--t-text-muted)' }} />
                <div>
                  <div style={{ fontWeight: 500 }}>No repo (home dir)</div>
                  <div style={{ fontSize: 11, color: 'var(--t-text-faint)' }}>~/</div>
                </div>
              </button>

              {repos.length > 0 ? <div style={sectionLabelStyle}>Repos</div> : null}
              {repos.map((repo) => (
                <button
                  type="button"
                  key={repo.localPath}
                  onClick={() => {
                    onNewTab(selectedAgent.id, repo);
                    setPickerOpen(false);
                    setPickerStep('terminal');
                    setSelectedAgent(null);
                  }}
                  style={submenuButtonStyle}
                  onMouseEnter={hoverOn}
                  onMouseLeave={hoverOff}
                >
                  <AgentDot color={selectedAgent.color} size={8} />
                  <div>
                    <div style={{ fontWeight: 500 }}>{repo.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--t-text-faint)', fontFamily: 'ui-monospace, monospace' }}>
                      {repo.localPath.replace(/^\/Users\/[^/]+\//, '~/')}
                    </div>
                  </div>
                </button>
              ))}

              <div style={{ height: 1, background: 'var(--t-divider)', marginTop: 4, marginBottom: 4 }} />

              <button
                type="button"
                onClick={async () => {
                  let folderPath: string | null = null;
                  try {
                    const { open } = await import('@tauri-apps/plugin-dialog');
                    const result = await open({ directory: true, title: 'Select project folder' });
                    if (typeof result === 'string') {
                      folderPath = result;
                    }
                  } catch {
                    try {
                      const res = await fetch('/api/panel/browse-folder', { method: 'POST' });
                      const data = await res.json();
                      if (data.path) {
                        folderPath = data.path;
                      }
                    } catch {
                      folderPath = window.prompt('Enter folder path:');
                    }
                  }

                  if (folderPath && selectedAgent) {
                    const folderName = folderPath.split('/').filter(Boolean).pop() ?? 'folder';
                    onNewTab(selectedAgent.id, { name: folderName, localPath: folderPath });
                    onRegisterRepo?.(folderPath);
                    setPickerOpen(false);
                    setPickerStep('terminal');
                    setSelectedAgent(null);
                  }
                }}
                style={submenuButtonStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
              >
                <span style={iconSlotStyle}>
                  <FolderOpen size={14} style={{ color: 'var(--t-text-muted)' }} />
                </span>
                <div style={{ fontWeight: 500 }}>Open folder...</div>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const WorkspaceLaunchPicker = memo(WorkspaceLaunchPickerBase);

const menuButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  paddingTop: 10,
  paddingBottom: 10,
  paddingLeft: 12,
  paddingRight: 12,
  border: 'none',
  background: 'transparent',
  color: 'var(--t-text)',
  fontSize: 13,
  fontFamily: '-apple-system, system-ui, sans-serif',
  cursor: 'pointer',
  textAlign: 'left' as const,
  transition: 'background 100ms',
};

const submenuButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  paddingTop: 8,
  paddingBottom: 8,
  paddingLeft: 12,
  paddingRight: 12,
  border: 'none',
  background: 'transparent',
  color: 'var(--t-text)',
  fontSize: 13,
  cursor: 'pointer',
  textAlign: 'left' as const,
  fontFamily: '-apple-system, system-ui, sans-serif',
  transition: 'background 100ms',
};

const backButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  paddingTop: 6,
  paddingBottom: 6,
  paddingLeft: 10,
  paddingRight: 10,
  border: 'none',
  borderBottom: '1px solid var(--t-divider)',
  background: 'transparent',
  color: 'var(--t-text-muted)',
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: '-apple-system, system-ui, sans-serif',
};

const sectionLabelStyle = {
  paddingTop: 6,
  paddingBottom: 4,
  paddingLeft: 10,
  paddingRight: 10,
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--t-text-faint)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase' as const,
};

const iconSlotStyle = {
  width: 20,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

function highlightOn(event: ReactMouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = THEME_ACCENT_SOFT;
}

function resetOn(event: ReactMouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
}

function hoverOn(event: ReactMouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'var(--t-hover)';
}

function hoverOff(event: ReactMouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
}
