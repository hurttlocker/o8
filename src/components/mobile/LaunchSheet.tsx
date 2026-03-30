'use client';

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';

interface RepoEntry {
  name: string;
  path: string;
  slug?: string;
}

interface LaunchSheetProps {
  open: boolean;
  onClose: () => void;
  onLaunched: (surfaceId?: string) => void;
}

const RUNTIMES = [
  { id: 'codex', label: 'Codex', color: '#34c759' },
  { id: 'claude-code', label: 'Claude Code', color: '#af52de' },
] as const;

const RUNTIME_ICONS: Record<string, string> = {
  'codex': 'M13 2L3 14h9l-1 8 10-12h-9l1-8z', // bolt
  'claude-code': 'M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z M9 21h6', // brain
};

function shortRepoName(name: string): string {
  const map: Record<string, string> = {
    'cortex-ide': 'Cortex IDE',
    'cortex': 'Cortex',
    'spear-production': 'Spear',
    'parasite-network': 'Parasite',
    'mybeautifulwife': 'Eyes Web',
  };
  return map[name] || name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export const LaunchSheet = memo(function LaunchSheet({
  open,
  onClose,
  onLaunched,
}: LaunchSheetProps) {
  const [task, setTask] = useState('');
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<RepoEntry | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState<string>('codex');
  const [branchMode, setBranchMode] = useState<'main' | 'new'>('main');
  const [newBranch, setNewBranch] = useState('');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch repos on open
  useEffect(() => {
    if (!open) return;
    fetch('/api/panel/repos')
      .then(r => r.json())
      .then(data => {
        const list = data.repos || data || [];
        setRepos(list);
        if (list.length > 0 && !selectedRepo) {
          setSelectedRepo(list[0]);
        }
      })
      .catch(() => {});
  }, [open, selectedRepo]);

  // Focus textarea on open
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 300);
    }
  }, [open]);

  const suggestedBranch = useMemo(() => {
    const slug = task
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40);
    return slug ? `feat/${slug}` : '';
  }, [task]);
  const branchValue = newBranch || suggestedBranch;

  const handleLaunch = useCallback(async () => {
    if (!task.trim() || !selectedRepo) return;
    setLaunching(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        runtime: selectedRuntime,
        prompt: task.trim(),
        cwd: selectedRepo.path,
        repoPath: selectedRepo.path,
      };

      if (branchMode === 'new' && branchValue.trim()) {
        body.baseBranch = branchValue.trim();
        body.isolate = true;
        body.skipSetup = false;
      } else {
        body.skipSetup = true;
      }

      const res = await fetch('/api/runtime/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const result = await res.json();

      if (!res.ok || !result.ok) {
        setError(result.error || 'Launch failed');
        setLaunching(false);
        return;
      }

      // Success — reset and navigate to new agent
      setTask('');
      setBranchMode('main');
      setNewBranch('');
      setLaunching(false);
      onLaunched(result.surfaceId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
      setLaunching(false);
    }
  }, [task, selectedRepo, selectedRuntime, branchMode, branchValue, onLaunched, onClose]);

  if (!open) return null;

  const canLaunch = task.trim().length > 5 && selectedRepo && !launching;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.3)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          zIndex: 9998,
          animation: 'launchFadeIn 200ms ease',
        }}
      />

      {/* Sheet */}
      <div style={{
        position: 'fixed',
        bottom: 0, left: 0, right: 0,
        maxHeight: '88dvh',
        borderRadius: '20px 20px 0 0',
        background: 'rgba(255,255,255,0.92)',
        backdropFilter: 'blur(40px) saturate(1.8)',
        WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
        border: '1px solid rgba(0,122,255,0.08)',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.12)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        animation: 'launchSlideUp 300ms cubic-bezier(0.32, 0.72, 0, 1)',
        overflow: 'hidden',
      }}>
        {/* Drag handle */}
        <div style={{
          display: 'flex', justifyContent: 'center',
          padding: '10px 0 4px',
        }}>
          <div style={{
            width: 36, height: 4, borderRadius: 2,
            background: 'rgba(0,0,0,0.12)',
          }} />
        </div>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '4px 20px 12px',
        }}>
          <h2 style={{
            margin: 0, fontSize: 22, fontWeight: 800,
            fontFamily: '-apple-system, system-ui, sans-serif',
            color: '#0a0a0a', letterSpacing: '-0.03em',
          }}>
            Launch Agent
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'rgba(0,0,0,0.06)',
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="#8e8e93" strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div style={{
          flex: 1, overflowY: 'auto',
          padding: '0 20px 20px',
          WebkitOverflowScrolling: 'touch',
        }}>
          {/* Task input */}
          <label style={{
            display: 'block',
            fontSize: 12, fontWeight: 700,
            color: '#8e8e93',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 6,
          }}>
            Task
          </label>
          <textarea
            ref={textareaRef}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="What should the agent do?"
            rows={3}
            style={{
              width: '100%',
              padding: '12px 14px',
              borderRadius: 12,
              border: '1px solid rgba(0,122,255,0.12)',
              background: 'rgba(0,122,255,0.03)',
              color: '#0a0a0a',
              fontSize: 15, fontWeight: 500,
              fontFamily: '-apple-system, system-ui, sans-serif',
              resize: 'none',
              outline: 'none',
              lineHeight: 1.5,
              boxSizing: 'border-box',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'rgba(0,122,255,0.3)';
              e.currentTarget.style.background = 'rgba(0,122,255,0.05)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(0,122,255,0.12)';
              e.currentTarget.style.background = 'rgba(0,122,255,0.03)';
            }}
          />

          {/* Repo picker */}
          <label style={{
            display: 'block',
            fontSize: 12, fontWeight: 700,
            color: '#8e8e93',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginTop: 16, marginBottom: 6,
          }}>
            Repository
          </label>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setRepoPickerOpen(v => !v)}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid rgba(0,122,255,0.12)',
                background: 'rgba(0,122,255,0.03)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span style={{
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="#007aff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span style={{
                  fontSize: 15, fontWeight: 600, color: '#0a0a0a',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}>
                  {selectedRepo ? shortRepoName(selectedRepo.name) : 'Select repo…'}
                </span>
              </span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="#c7c7cc" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                style={{
                  transition: 'transform 200ms ease',
                  transform: repoPickerOpen ? 'rotate(180deg)' : 'none',
                }}>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Repo dropdown */}
            {repoPickerOpen && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0, right: 0,
                marginTop: 4,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.92)',
                backdropFilter: 'blur(40px) saturate(1.8)',
                WebkitBackdropFilter: 'blur(40px) saturate(1.8)',
                border: '1px solid rgba(0,122,255,0.12)',
                boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
                padding: '4px 0',
                zIndex: 10,
                maxHeight: 200,
                overflowY: 'auto',
              }}>
                {repos.map((repo) => (
                  <button
                    key={repo.path}
                    type="button"
                    onClick={() => {
                      setSelectedRepo(repo);
                      setRepoPickerOpen(false);
                    }}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      border: 'none',
                      background: selectedRepo?.path === repo.path ? 'rgba(0,122,255,0.08)' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <span style={{
                      fontSize: 14, fontWeight: 600, color: '#0a0a0a',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                    }}>
                      {shortRepoName(repo.name)}
                    </span>
                    {selectedRepo?.path === repo.path && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                        stroke="#007aff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Runtime picker — iOS segmented control */}
          <label style={{
            display: 'block',
            fontSize: 12, fontWeight: 700,
            color: '#8e8e93',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginTop: 16, marginBottom: 6,
          }}>
            Runtime
          </label>
          <div style={{
            display: 'flex',
            padding: 3,
            borderRadius: 10,
            background: 'rgba(0,122,255,0.04)',
            border: '1px solid rgba(0,122,255,0.08)',
            gap: 2,
          }}>
            {RUNTIMES.map((rt) => {
              const active = selectedRuntime === rt.id;
              return (
                <button
                  key={rt.id}
                  type="button"
                  onClick={() => setSelectedRuntime(rt.id)}
                  style={{
                    flex: 1,
                    padding: '9px 4px',
                    borderRadius: 8,
                    border: 'none',
                    background: active ? '#fff' : 'transparent',
                    boxShadow: active ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 5,
                    transition: 'all 200ms ease',
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke={active ? rt.color : '#8e8e93'}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={RUNTIME_ICONS[rt.id] || ''} />
                  </svg>
                  <span style={{
                    fontSize: 12, fontWeight: 600,
                    color: active ? '#0a0a0a' : '#8e8e93',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}>
                    {rt.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Branch mode — iOS segmented control */}
          <label style={{
            display: 'block',
            fontSize: 12, fontWeight: 700,
            color: '#8e8e93',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginTop: 16, marginBottom: 6,
          }}>
            Branch
          </label>
          <div style={{
            display: 'flex',
            padding: 3,
            borderRadius: 10,
            background: 'rgba(0,122,255,0.04)',
            border: '1px solid rgba(0,122,255,0.08)',
            gap: 2,
          }}>
            {[
              { id: 'main' as const, label: 'On main' },
              { id: 'new' as const, label: 'New branch' },
            ].map((opt) => {
              const active = branchMode === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setBranchMode(opt.id)}
                  style={{
                    flex: 1,
                    padding: '9px 4px',
                    borderRadius: 8,
                    border: 'none',
                    background: active ? '#fff' : 'transparent',
                    boxShadow: active ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                    transition: 'all 200ms ease',
                  }}
                >
                  <span style={{
                    fontSize: 13, fontWeight: 600,
                    color: active ? '#0a0a0a' : '#8e8e93',
                    fontFamily: '-apple-system, system-ui, sans-serif',
                  }}>
                    {opt.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* New branch name input */}
          {branchMode === 'new' && (
            <input
              type="text"
              value={branchValue}
              onChange={(e) => setNewBranch(e.target.value)}
              placeholder="feat/my-feature"
              style={{
                width: '100%',
                marginTop: 8,
                padding: '10px 14px',
                borderRadius: 10,
                border: '1px solid rgba(0,122,255,0.12)',
                background: 'rgba(0,122,255,0.03)',
                color: '#0a0a0a',
                fontSize: 13, fontWeight: 600,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          )}

          {/* Error */}
          {error && (
            <div style={{
              marginTop: 12,
              padding: '10px 14px',
              borderRadius: 10,
              background: 'rgba(255,59,48,0.06)',
              border: '1px solid rgba(255,59,48,0.15)',
              color: '#ff3b30',
              fontSize: 13, fontWeight: 600,
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Launch button — fixed at bottom */}
        <div style={{
          padding: '12px 20px',
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
          borderTop: '1px solid rgba(0,0,0,0.04)',
        }}>
          <button
            type="button"
            onClick={handleLaunch}
            disabled={!canLaunch}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: 14,
              border: 'none',
              background: canLaunch ? '#007aff' : 'rgba(0,122,255,0.15)',
              color: canLaunch ? '#fff' : 'rgba(0,122,255,0.4)',
              fontSize: 16, fontWeight: 700,
              fontFamily: '-apple-system, system-ui, sans-serif',
              cursor: canLaunch ? 'pointer' : 'default',
              WebkitTapHighlightColor: 'transparent',
              transition: 'all 200ms ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {launching ? (
              <>
                <span style={{
                  width: 16, height: 16,
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'launchSpin 600ms linear infinite',
                }} />
                Launching…
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2L11 13" />
                  <path d="M22 2L15 22 11 13 2 9z" />
                </svg>
                Launch Agent
              </>
            )}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes launchSlideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
        @keyframes launchFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes launchSpin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </>
  );
});
