'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useMemo, useState } from 'react';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import type { SetupWarmProfileContext, SetupWarmRuntimeAvailability } from '@/lib/setup/types';

const SPRING = {
  type: 'spring' as const,
  stiffness: 400,
  damping: 30,
};

function shortenPath(value: string) {
  const userPath = value.replace(/^\/Users\/[^/]+/, '~');
  if (userPath !== value) return userPath;
  return value.replace(/^\/home\/[^/]+/, '~');
}

function hasProfileContext(profile: SetupWarmProfileContext | null | undefined) {
  if (!profile) return false;
  if ((profile.importedTopicsCount ?? 0) > 0) return true;
  if ((profile.labels ?? []).length > 0) return true;
  return Boolean(profile.summary?.trim());
}

function formatRuntimeCopy(runtime: SetupWarmRuntimeAvailability) {
  if (!runtime.detected) return `${runtime.label} not found`;
  if (runtime.id === 'gemini') return `${runtime.label} available`;
  return `${runtime.label} ready`;
}

function formatProfileLabel(profile: SetupWarmProfileContext) {
  const importedTopicsCount = profile.importedTopicsCount ?? 0;
  if (importedTopicsCount > 0) {
    return `${importedTopicsCount} topic${importedTopicsCount === 1 ? '' : 's'} imported`;
  }
  if ((profile.labels ?? []).length > 0) {
    return `Profile: ${(profile.labels ?? []).slice(0, 3).join(', ')}`;
  }
  return 'Profile context ready';
}

function buildRepoStatus(readiness?: RepoReadiness | null) {
  if (readiness?.state === 'ready' && readiness.onDefaultBranch && !readiness.dirty) {
    return {
      label: 'Ready',
      tone: 'var(--t-success, #16a34a)',
      background: 'var(--t-success-soft, rgba(22, 163, 74, 0.10))',
      border: 'var(--t-success-border, rgba(22, 163, 74, 0.18))',
      summary: readiness.summary,
    };
  }

  if (
    readiness?.state === 'blocked'
    || readiness?.state === 'needs_setup'
    || (readiness?.missingEnvFiles?.length ?? 0) > 0
  ) {
    return {
      label: 'Needs setup',
      tone: 'var(--t-warning, #f59e0b)',
      background: 'var(--t-warning-soft, rgba(245, 158, 11, 0.10))',
      border: 'var(--t-warning-border, rgba(245, 158, 11, 0.18))',
      summary: readiness?.nextAction ?? readiness?.summary ?? 'Finish the saved setup steps before using this repo.',
    };
  }

  if (readiness?.dirty) {
    return {
      label: 'Working tree changed',
      tone: 'var(--t-text-muted, #4b5563)',
      background: 'var(--t-bg-card, rgba(148, 163, 184, 0.12))',
      border: 'var(--t-panel-border, rgba(15, 23, 42, 0.08))',
      summary: readiness.summary,
    };
  }

  if (readiness?.onDefaultBranch === false) {
    return {
      label: 'Branch differs',
      tone: 'var(--t-text-muted, #4b5563)',
      background: 'var(--t-bg-card, rgba(148, 163, 184, 0.12))',
      border: 'var(--t-panel-border, rgba(15, 23, 42, 0.08))',
      summary: readiness.summary,
    };
  }

  return {
    label: readiness?.label ?? 'Saved',
    tone: 'var(--t-text-faint, #6b7280)',
    background: 'var(--t-bg-card, rgba(148, 163, 184, 0.10))',
    border: 'var(--t-panel-border, rgba(15, 23, 42, 0.08))',
    summary: readiness?.summary ?? 'Repo connection is saved.',
  };
}

export function WarmRuntimeBar({
  runtimes,
}: {
  runtimes: SetupWarmRuntimeAvailability[];
}) {
  const hasRuntimes = runtimes.length > 0;

  if (!hasRuntimes) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        minHeight: 44,
        padding: '0 18px',
        borderBottom: '1px solid var(--t-divider-subtle, rgba(15, 23, 42, 0.06))',
        background: 'linear-gradient(180deg, var(--t-panel-translucent, rgba(255, 255, 255, 0.84)), rgba(255, 255, 255, 0.42))',
        backdropFilter: 'blur(18px) saturate(1.04)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.04)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--t-text-muted, #4b5563)',
          letterSpacing: '-0.01em',
          flexShrink: 0,
        }}
      >
        Runtime availability
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          minWidth: 0,
          flexWrap: 'wrap',
          padding: '8px 0',
        }}
      >
        {runtimes.map((runtime) => (
          <div
            key={runtime.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              minHeight: 28,
              fontSize: 12,
              lineHeight: 1.4,
              letterSpacing: '-0.01em',
              color: runtime.detected ? 'var(--t-text, #0f172a)' : 'var(--t-text-muted, #4b5563)',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: runtime.detected ? 'var(--t-success, #16a34a)' : 'var(--t-text-faint, #94a3b8)',
                boxShadow: runtime.detected ? '0 0 0 4px var(--t-success-soft, rgba(22, 163, 74, 0.10))' : 'none',
                flexShrink: 0,
              }}
            />
            <span>{formatRuntimeCopy(runtime)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WarmSidebarState({
  repos,
  selectedRepoId,
  profile,
  onOpenRepo,
}: {
  repos: RepoRegistryEntry[];
  selectedRepoId?: string | null;
  profile?: SetupWarmProfileContext | null;
  onOpenRepo: (repo: RepoRegistryEntry) => void;
}) {
  const [profileOpen, setProfileOpen] = useState(false);
  const hasProfile = hasProfileContext(profile);
  const hasRepos = repos.length > 0;
  const hasContent = hasProfile || hasRepos;
  const repoSummary = useMemo(() => {
    if (!hasRepos) return null;
    const readyCount = repos.filter((repo) => {
      const status = buildRepoStatus(repo.readiness);
      return status.label === 'Ready';
    }).length;
    return `${readyCount}/${repos.length} repos ready`;
  }, [hasRepos, repos]);

  if (!hasContent) {
    return null;
  }

  return (
    <div
      style={{
        padding: '8px 10px 0',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: 12,
          borderRadius: 14,
          border: '1px solid var(--t-panel-border, rgba(15, 23, 42, 0.08))',
          background: 'linear-gradient(180deg, var(--t-panel-translucent, rgba(255, 255, 255, 0.88)), rgba(255, 255, 255, 0.72))',
          boxShadow: '0 10px 28px var(--t-panel-shadow, rgba(15, 23, 42, 0.08))',
          backdropFilter: 'blur(22px) saturate(1.04)',
          WebkitBackdropFilter: 'blur(22px) saturate(1.04)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                lineHeight: 1.3,
                fontWeight: 700,
                color: 'var(--t-text, #0f172a)',
                letterSpacing: '-0.02em',
              }}
            >
              Ready on launch
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 12,
                lineHeight: 1.4,
                color: 'var(--t-text-muted, #4b5563)',
                letterSpacing: '-0.01em',
              }}
            >
              {repoSummary ?? 'Saved onboarding context is available.'}
            </div>
          </div>
        </div>

        {hasProfile && profile ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              type="button"
              onClick={() => setProfileOpen((current) => !current)}
              aria-expanded={profileOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                minHeight: 44,
                width: '100%',
                padding: '11px 12px',
                borderRadius: 10,
                border: '1px solid var(--t-accent-border, rgba(37, 99, 235, 0.16))',
                background: profileOpen
                  ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.12))'
                  : 'var(--t-bg-card, rgba(37, 99, 235, 0.08))',
                color: 'var(--t-text, #0f172a)',
                cursor: 'pointer',
                appearance: 'none',
                WebkitAppearance: 'none',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <span
                style={{
                  minWidth: 0,
                  fontSize: 12,
                  lineHeight: 1.4,
                  letterSpacing: '-0.01em',
                }}
              >
                {formatProfileLabel(profile)}
              </span>
              <span
                aria-hidden="true"
                style={{
                  color: 'var(--t-text-muted, #4b5563)',
                  fontSize: 16,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                {profileOpen ? '-' : '+'}
              </span>
            </button>

            <AnimatePresence initial={false}>
              {profileOpen ? (
                <motion.div
                  initial={{ opacity: 0, height: 0, y: -6 }}
                  animate={{ opacity: 1, height: 'auto', y: 0 }}
                  exit={{ opacity: 0, height: 0, y: -4 }}
                  transition={SPRING}
                  style={{
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: '4px 2px 0',
                    }}
                  >
                    {profile.summary?.trim() ? (
                      <div
                        style={{
                          fontSize: 12,
                          lineHeight: 1.5,
                          color: 'var(--t-text-secondary, #374151)',
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {profile.summary.trim()}
                      </div>
                    ) : null}
                    {(profile.labels ?? []).length > 0 ? (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 6,
                        }}
                      >
                        {(profile.labels ?? []).slice(0, 6).map((label) => (
                          <span
                            key={label}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              minHeight: 28,
                              padding: '6px 10px',
                              borderRadius: 10,
                              background: 'var(--t-panel, rgba(255, 255, 255, 0.92))',
                              border: '1px solid var(--t-panel-border, rgba(15, 23, 42, 0.08))',
                              color: 'var(--t-text-secondary, #374151)',
                              fontSize: 11,
                              lineHeight: 1,
                              letterSpacing: '-0.01em',
                            }}
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {profile.importedTopicsCount ? (
                      <div
                        style={{
                          fontSize: 11,
                          lineHeight: 1.4,
                          color: 'var(--t-text-muted, #4b5563)',
                          letterSpacing: '-0.01em',
                        }}
                      >
                        Imported from {profile.source ?? 'saved context'} with {profile.importedTopicsCount} topic{profile.importedTopicsCount === 1 ? '' : 's'}.
                      </div>
                    ) : null}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        ) : null}

        {hasRepos ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {repos.map((repo) => {
              const status = buildRepoStatus(repo.readiness);
              const branchLabel = repo.readiness?.currentBranch ?? repo.defaultBranch;
              const detailParts = [branchLabel, shortenPath(repo.localPath)].filter(Boolean);
              const isSelected = repo.id === selectedRepoId;

              return (
                <button
                  key={repo.id}
                  type="button"
                  onClick={() => onOpenRepo(repo)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 44,
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: `1px solid ${isSelected ? 'var(--t-accent-border, rgba(37, 99, 235, 0.18))' : status.border}`,
                    background: isSelected
                      ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.10))'
                      : status.background,
                    cursor: 'pointer',
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: status.tone,
                      boxShadow: `0 0 0 4px ${status.background}`,
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 12,
                          lineHeight: 1.4,
                          fontWeight: 700,
                          color: 'var(--t-text, #0f172a)',
                          letterSpacing: '-0.01em',
                        }}
                      >
                        {repo.name}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          lineHeight: 1.2,
                          color: status.tone,
                          letterSpacing: '-0.01em',
                          flexShrink: 0,
                        }}
                      >
                        {status.label}
                      </span>
                    </span>
                    <span
                      title={status.summary}
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 11,
                        lineHeight: 1.35,
                        color: 'var(--t-text-muted, #4b5563)',
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {detailParts.join(' | ')}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      color: 'var(--t-text-faint, #6b7280)',
                      fontSize: 16,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    &gt;
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function WarmCompletionBadge({
  visible,
  repoCount,
  runtimeCount,
}: {
  visible: boolean;
  repoCount: number;
  runtimeCount: number;
}) {
  return (
    <AnimatePresence>
      {visible ? (
        <motion.div
          initial={{ opacity: 0, y: -10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={SPRING}
          style={{
            position: 'fixed',
            top: 58,
            right: 20,
            zIndex: 60,
            pointerEvents: 'none',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '12px 14px',
              borderRadius: 14,
              border: '1px solid var(--t-panel-border, rgba(15, 23, 42, 0.08))',
              background: 'linear-gradient(180deg, var(--t-panel-translucent, rgba(255, 255, 255, 0.94)), rgba(255, 255, 255, 0.82))',
              boxShadow: '0 16px 40px rgba(15, 23, 42, 0.10)',
              backdropFilter: 'blur(22px) saturate(1.05)',
              WebkitBackdropFilter: 'blur(22px) saturate(1.05)',
            }}
          >
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.3,
                fontWeight: 700,
                color: 'var(--t-text, #0f172a)',
                letterSpacing: '-0.02em',
              }}
            >
              Setup complete
            </div>
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.4,
                color: 'var(--t-text-muted, #4b5563)',
                letterSpacing: '-0.01em',
              }}
            >
              {repoCount} repo{repoCount === 1 ? '' : 's'} | {runtimeCount} runtime{runtimeCount === 1 ? '' : 's'}
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
