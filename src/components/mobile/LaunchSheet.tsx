'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { correlatedActionIsUnsettled } from '@/lib/orchestrator/action-receipt';
import { fetchRuntimeLaunchReceipt } from '@/lib/orchestrator/runtime-mutation-receipt';
import { useTheme } from './ThemeContext';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

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
  { id: 'codex', label: 'Codex', color: '#64d2ff' },
  { id: 'claude-code', label: 'Claude Code', color: '#bf5af2' },
] as const;

const RUNTIME_ICONS: Record<string, string> = {
  codex: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  'claude-code': 'M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z M9 21h6',
};

function sectionHeaderStyle(colors: ThemeColors) {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
  };
}

function shortRepoName(name: string): string {
  const map: Record<string, string> = {
    'cortex-ide': 'o8',
    cortex: 'Cortex',
    'spear-production': 'Spear',
    'parasite-network': 'Parasite',
    mybeautifulwife: 'Eyes Web',
  };
  return map[name] || name.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export const LaunchSheet = memo(function LaunchSheet({
  open,
  onClose,
  onLaunched,
}: LaunchSheetProps) {
  const { colors } = useTheme();
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

  useEffect(() => {
    if (!open) return;
    fetch('/api/panel/repos')
      .then((response) => response.json())
      .then((data) => {
        const list = data.repos || data || [];
        setRepos(list);
        if (list.length > 0 && !selectedRepo) {
          setSelectedRepo(list[0]);
        }
      })
      .catch(() => {});
  }, [open, selectedRepo]);

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

      const { response, payload: result } = await fetchRuntimeLaunchReceipt(body);

      if (!response.ok || !result?.ok || !result.surfaceId) {
        setError(result?.error || result?.note || 'Launch failed.');
        setLaunching(false);
        return;
      }

      setTask('');
      setBranchMode('main');
      setNewBranch('');
      setLaunching(false);
      onLaunched(result.surfaceId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
      if (!correlatedActionIsUnsettled(err)) setLaunching(false);
    }
  }, [task, selectedRepo, selectedRuntime, branchMode, branchValue, onLaunched, onClose]);

  if (!open) return null;

  const canLaunch = task.trim().length > 5 && selectedRepo && !launching;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.78)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          zIndex: 9998,
        }}
      />

      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          maxHeight: '88dvh',
          borderRadius: '24px 24px 0 0',
          background: colors.bg,
          borderTop: `1px solid ${colors.cardBorder}`,
          boxShadow: '0 -16px 40px rgba(0,0,0,0.45)',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: colors.textTertiary }} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 20px 12px', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: colors.text, letterSpacing: '-0.03em' }}>
            Launch Agent
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={colors.textSecondary} strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px', WebkitOverflowScrolling: 'touch' }}>
          <label style={sectionHeaderStyle(colors)}>Task</label>
          <textarea
            ref={textareaRef}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="What should the agent do?"
            rows={4}
            style={{
              width: '100%',
              minHeight: 116,
              padding: '12px 14px',
              borderRadius: 14,
              border: `1px solid ${colors.cardBorder}`,
              background: colors.cardBg,
              color: colors.text,
              fontSize: 15,
              fontWeight: 500,
              resize: 'none',
              outline: 'none',
              lineHeight: 1.5,
              boxSizing: 'border-box',
            }}
          />

          <label style={{ ...sectionHeaderStyle(colors), marginTop: 16 }}>Repository</label>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setRepoPickerOpen((value) => !value)}
              style={{
                width: '100%',
                minHeight: 44,
                padding: '0 14px',
                borderRadius: 14,
                border: `1px solid ${colors.cardBorder}`,
                background: colors.cardBg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.blueAccent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span style={{ fontSize: 15, fontWeight: 600, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedRepo ? shortRepoName(selectedRepo.name) : 'Select repo...'}
                </span>
              </span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.textTertiary}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ transform: repoPickerOpen ? 'rotate(180deg)' : 'none' }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {repoPickerOpen ? (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  marginTop: 4,
                  borderRadius: 14,
                  background: colors.cardBg,
                  border: `1px solid ${colors.cardBorder}`,
                  padding: '4px 0',
                  zIndex: 10,
                  maxHeight: 220,
                  overflowY: 'auto',
                }}
              >
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
                      minHeight: 44,
                      padding: '0 14px',
                      border: 'none',
                      background: selectedRepo?.path === repo.path ? colors.blueGlass : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{shortRepoName(repo.name)}</span>
                    {selectedRepo?.path === repo.path ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.blueAccent} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <label style={{ ...sectionHeaderStyle(colors), marginTop: 16 }}>Runtime</label>
          <div
            style={{
              display: 'flex',
              gap: 4,
              padding: 4,
              borderRadius: 14,
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            {RUNTIMES.map((runtime) => {
              const active = selectedRuntime === runtime.id;
              return (
                <button
                  key={runtime.id}
                  type="button"
                  onClick={() => setSelectedRuntime(runtime.id)}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 12,
                    border: active ? `1px solid ${colors.blueGlassBorder}` : '1px solid transparent',
                    background: active ? colors.blueGlass : 'transparent',
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={active ? runtime.color : colors.textSecondary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d={RUNTIME_ICONS[runtime.id] || ''} />
                  </svg>
                  <span style={{ fontSize: 12, fontWeight: 600, color: active ? colors.text : colors.textSecondary }}>
                    {runtime.label}
                  </span>
                </button>
              );
            })}
          </div>

          <label style={{ ...sectionHeaderStyle(colors), marginTop: 16 }}>Branch</label>
          <div
            style={{
              display: 'flex',
              gap: 4,
              padding: 4,
              borderRadius: 14,
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            {[
              { id: 'main' as const, label: 'On main' },
              { id: 'new' as const, label: 'New branch' },
            ].map((option) => {
              const active = branchMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setBranchMode(option.id)}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 12,
                    border: active ? `1px solid ${colors.blueGlassBorder}` : '1px solid transparent',
                    background: active ? colors.blueGlass : 'transparent',
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: active ? colors.text : colors.textSecondary }}>
                    {option.label}
                  </span>
                </button>
              );
            })}
          </div>

          {branchMode === 'new' ? (
            <input
              type="text"
              value={branchValue}
              onChange={(event) => setNewBranch(event.target.value)}
              placeholder="feat/my-feature"
              style={{
                width: '100%',
                minHeight: 44,
                marginTop: 8,
                padding: '0 14px',
                borderRadius: 14,
                border: `1px solid ${colors.cardBorder}`,
                background: colors.cardBg,
                color: colors.text,
                fontSize: 13,
                fontWeight: 600,
                fontFamily: '"SF Mono", ui-monospace, monospace',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          ) : null}

          {error ? (
            <div
              style={{
                marginTop: 12,
                padding: '12px 14px',
                borderRadius: 14,
                background: colors.cardBg,
                border: '1px solid rgba(255,69,58,0.24)',
                color: '#ff453a',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {error}
            </div>
          ) : null}
        </div>

        <div
          style={{
            padding: '12px 20px',
            paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
            borderTop: `1px solid ${colors.cardBorder}`,
          }}
        >
          <button
            type="button"
            onClick={handleLaunch}
            disabled={!canLaunch}
            style={{
              width: '100%',
              minHeight: 48,
              borderRadius: 12,
              border: 'none',
              background: canLaunch ? colors.blueAccent : 'rgba(10,132,255,0.24)',
              color: canLaunch ? colors.text : 'rgba(245,245,247,0.55)',
              fontSize: 16,
              fontWeight: 700,
              cursor: canLaunch ? 'pointer' : 'default',
              WebkitTapHighlightColor: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            {launching ? (
              'Launching...'
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2L11 13" />
                  <path d="M22 2L15 22 11 13 2 9z" />
                </svg>
                Launch Agent
              </>
            )}
          </button>
        </div>
      </div>
    </>
  );
});
