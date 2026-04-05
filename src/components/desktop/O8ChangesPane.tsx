'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionButton,
  CheckIcon,
  ChevronIcon,
  CopyIcon,
  DiffBlock,
  ExternalLinkIcon,
  filterLabel,
  formatRelativeTime,
  itemLabel,
  matchesCommitSha,
  type ChangeFilter,
} from './O8ChangesPaneParts';

interface GitChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  staged: boolean;
}

interface RecentCommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  additions: number;
  deletions: number;
}

interface CommitDiffFile {
  path: string;
  previousPath?: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  additions: number;
  deletions: number;
  diff: string;
}

interface O8ChangesPaneProps {
  repoPath?: string | null;
  repoSlug?: string | null;
  initialCommitSha?: string | null;
}


export function O8ChangesPane({ repoPath, repoSlug, initialCommitSha }: O8ChangesPaneProps) {
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [commits, setCommits] = useState<RecentCommitSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ChangeFilter>(() => initialCommitSha ? 'commits' : 'uncommitted');
  const [filterOpen, setFilterOpen] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const [expandedCommitSha, setExpandedCommitSha] = useState<string | null>(initialCommitSha ?? null);
  const [commitDiffs, setCommitDiffs] = useState<Record<string, CommitDiffFile[]>>({});
  const [commitDiffLoadingBySha, setCommitDiffLoadingBySha] = useState<Record<string, boolean>>({});
  const [commitDiffErrors, setCommitDiffErrors] = useState<Record<string, string>>({});
  const [copiedCommitSha, setCopiedCommitSha] = useState<string | null>(null);

  const activeItemsCount = filter === 'commits' ? commits.length : files.length;
  const totalAdditions = useMemo(() => (
    filter === 'commits'
      ? commits.reduce((sum, commit) => sum + commit.additions, 0)
      : files.reduce((sum, file) => sum + file.additions, 0)
  ), [commits, files, filter]);
  const totalDeletions = useMemo(() => (
    filter === 'commits'
      ? commits.reduce((sum, commit) => sum + commit.deletions, 0)
      : files.reduce((sum, file) => sum + file.deletions, 0)
  ), [commits, files, filter]);

  const resolveCommitSha = useCallback((value?: string | null) => {
    if (!value) return null;
    const matched = commits.find((commit) => (
      matchesCommitSha(commit.sha, value)
      || matchesCommitSha(commit.shortSha, value)
    ));
    return matched?.sha ?? value.trim();
  }, [commits]);

  const fetchChanges = useCallback(async () => {
    if (!repoPath) {
      setFiles([]);
      setCommits([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const workspaceParam = encodeURIComponent(repoPath);

      if (filter === 'commits') {
        const response = await fetch(`/api/panel/commits?workspace=${workspaceParam}&limit=20`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { commits?: RecentCommitSummary[] };
        setCommits(Array.isArray(data.commits) ? data.commits : []);
        return;
      }

      const response = await fetch(`/api/panel/git-status?workspace=${workspaceParam}&filter=${filter}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { files?: GitChangedFile[] };
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch {
      if (filter === 'commits') {
        setCommits([]);
      } else {
        setFiles([]);
      }
    } finally {
      setLoading(false);
    }
  }, [filter, repoPath]);

  // Track in-flight + cached SHAs via ref to avoid re-render loops in useCallback deps
  const diffCacheRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());

  const loadCommitDiff = useCallback(async (sha: string) => {
    const resolvedSha = resolveCommitSha(sha);
    if (!repoPath || !resolvedSha) return;
    if (diffCacheRef.current.has(resolvedSha) || inFlightRef.current.has(resolvedSha)) return;

    inFlightRef.current.add(resolvedSha);
    setCommitDiffLoadingBySha((current) => ({ ...current, [resolvedSha]: true }));
    setCommitDiffErrors((current) => {
      const next = { ...current };
      delete next[resolvedSha];
      return next;
    });

    try {
      const workspaceParam = encodeURIComponent(repoPath);
      const shaParam = encodeURIComponent(resolvedSha);
      const response = await fetch(`/api/panel/commit-diff?sha=${shaParam}&workspace=${workspaceParam}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { files?: CommitDiffFile[] };
      diffCacheRef.current.add(resolvedSha);
      setCommitDiffs((current) => ({
        ...current,
        [resolvedSha]: Array.isArray(data.files) ? data.files : [],
      }));
    } catch {
      setCommitDiffErrors((current) => ({
        ...current,
        [resolvedSha]: 'Failed to load commit diff',
      }));
    } finally {
      inFlightRef.current.delete(resolvedSha);
      setCommitDiffLoadingBySha((current) => ({ ...current, [resolvedSha]: false }));
    }
  }, [repoPath, resolveCommitSha]);

  const handleFileClick = useCallback(async (filePath: string) => {
    if (expandedFile === filePath) {
      setExpandedFile(null);
      setExpandedDiff(null);
      return;
    }

    setExpandedFile(filePath);
    setExpandedDiff(null);

    if (!repoPath) return;

    try {
      const workspaceParam = encodeURIComponent(repoPath);
      const fileParam = encodeURIComponent(filePath);
      const response = await fetch(`/api/panel/file-diff?path=${fileParam}&workspace=${workspaceParam}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { diff?: string; stagedDiff?: string };
      setExpandedDiff(data.diff || data.stagedDiff || 'No diff available');
    } catch {
      setExpandedDiff('Failed to load diff');
    }
  }, [expandedFile, repoPath]);

  const handleCommitToggle = useCallback((sha: string) => {
    const resolvedSha = resolveCommitSha(sha);
    if (!resolvedSha) return;

    setExpandedCommitSha((current) => current === resolvedSha ? null : resolvedSha);
  }, [resolveCommitSha]);

  const handleCopySha = useCallback(async (sha: string) => {
    const resolvedSha = resolveCommitSha(sha);
    if (!resolvedSha || !navigator.clipboard?.writeText) return;

    try {
      await navigator.clipboard.writeText(resolvedSha);
      setCopiedCommitSha(resolvedSha);
      window.setTimeout(() => {
        setCopiedCommitSha((current) => current === resolvedSha ? null : current);
      }, 1400);
    } catch {
      setCopiedCommitSha(null);
    }
  }, [resolveCommitSha]);

  const handleViewOnGitHub = useCallback((sha: string) => {
    const resolvedSha = resolveCommitSha(sha);
    if (!resolvedSha || !repoSlug) return;
    window.open(`https://github.com/${repoSlug}/commit/${resolvedSha}`, '_blank', 'noopener,noreferrer');
  }, [repoSlug, resolveCommitSha]);

  useEffect(() => {
    void fetchChanges();
  }, [fetchChanges]);

  useEffect(() => {
    setExpandedFile(null);
    setExpandedDiff(null);
    setExpandedCommitSha(initialCommitSha ?? null);
    setCommitDiffs({});
    setCommitDiffErrors({});
    setCommitDiffLoadingBySha({});
    setCopiedCommitSha(null);
    diffCacheRef.current.clear();
    inFlightRef.current.clear();
  }, [initialCommitSha, repoPath]);

  useEffect(() => {
    if (!initialCommitSha) return;
    setFilter('commits');
    setExpandedCommitSha(resolveCommitSha(initialCommitSha));
  }, [initialCommitSha, resolveCommitSha]);

  useEffect(() => {
    if (filter !== 'commits' || !expandedCommitSha || loading) return;
    const resolvedSha = resolveCommitSha(expandedCommitSha);
    if (!resolvedSha) return;
    void loadCommitDiff(resolvedSha);
  }, [expandedCommitSha, filter, loading, loadCommitDiff, resolveCommitSha]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1e2028' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 12,
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setFilterOpen((current) => !current)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              paddingTop: 0,
              paddingRight: 10,
              paddingBottom: 0,
              paddingLeft: 10,
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.04)',
              color: 'rgba(255,255,255,0.85)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            {itemLabel(filter, activeItemsCount)}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.55 }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {filterOpen ? (
            <>
              <div onClick={() => setFilterOpen(false)} style={{ position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 99 }} />
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 6,
                  minWidth: 176,
                  paddingTop: 4,
                  paddingRight: 4,
                  paddingBottom: 4,
                  paddingLeft: 4,
                  borderRadius: 12,
                  border: '1px solid rgba(255,255,255,0.1)',
                  background: '#232631',
                  boxShadow: '0 14px 32px rgba(0,0,0,0.35)',
                  zIndex: 100,
                }}
              >
                {(['uncommitted', 'staged', 'unstaged', 'branch', 'commits'] as ChangeFilter[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => {
                      setFilter(option);
                      setFilterOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      minHeight: 30,
                      paddingTop: 0,
                      paddingRight: 10,
                      paddingBottom: 0,
                      paddingLeft: 10,
                      border: 'none',
                      borderRadius: 8,
                      background: filter === option ? 'rgba(59,130,246,0.16)' : 'transparent',
                      color: '#e2e8f0',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: '-apple-system, system-ui, sans-serif',
                    }}
                    onMouseEnter={(event) => {
                      if (filter === option) return;
                      event.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                    }}
                    onMouseLeave={(event) => {
                      if (filter === option) return;
                      event.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {filterLabel(option)}
                    {filter === option ? <CheckIcon size={12} color="#93c5fd" /> : null}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        {activeItemsCount > 0 ? (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.58)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
            <span style={{ color: '#4ade80' }}>+{totalAdditions}</span>
            {' '}
            <span style={{ color: '#f87171' }}>-{totalDeletions}</span>
          </span>
        ) : null}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => void fetchChanges()}
          title="Refresh"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            border: 'none',
            borderRadius: 6,
            background: 'transparent',
            color: 'rgba(255,255,255,0.52)',
            cursor: 'pointer',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <div style={{ paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24, color: 'rgba(255,255,255,0.5)', fontSize: 13, textAlign: 'center' }}>Loading...</div>
        ) : filter === 'commits' ? (
          commits.length === 0 ? (
            <div style={{ paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24, color: 'rgba(255,255,255,0.4)', fontSize: 13, textAlign: 'center' }}>
              No recent commits
            </div>
          ) : (
            <div style={{ paddingTop: 10, paddingRight: 12, paddingBottom: 14, paddingLeft: 12 }}>
              {commits.map((commit) => {
                const isExpanded = expandedCommitSha === commit.sha;
                const commitDiffFiles = commitDiffs[commit.sha] ?? [];
                const diffLoading = commitDiffLoadingBySha[commit.sha] ?? false;
                const diffError = commitDiffErrors[commit.sha];
                const displayMessage = commit.subject || commit.message || commit.shortSha;

                return (
                  <div
                    key={commit.sha}
                    style={{
                      borderRadius: 14,
                      border: isExpanded ? '1px solid rgba(96,165,250,0.26)' : '1px solid rgba(255,255,255,0.08)',
                      background: isExpanded ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.03)',
                      boxShadow: isExpanded ? '0 8px 24px rgba(15,23,42,0.22)' : 'none',
                      marginBottom: 10,
                      overflow: 'hidden',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => handleCommitToggle(commit.sha)}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        width: '100%',
                        paddingTop: 12,
                        paddingRight: 14,
                        paddingBottom: 12,
                        paddingLeft: 14,
                        border: 'none',
                        background: 'transparent',
                        color: '#e2e8f0',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                      onMouseEnter={(event) => {
                        if (isExpanded) return;
                        event.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                      }}
                      onMouseLeave={(event) => {
                        if (isExpanded) return;
                        event.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ paddingTop: 3 }}>
                        <ChevronIcon open={isExpanded} size={11} color="rgba(255,255,255,0.7)" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 13,
                            fontWeight: 600,
                            letterSpacing: '-0.01em',
                            color: '#e2e8f0',
                          }}
                        >
                          {displayMessage}
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 6,
                            marginTop: 5,
                            fontSize: 11,
                            color: 'rgba(255,255,255,0.65)',
                            fontFamily: '"SF Mono", ui-monospace, monospace',
                          }}
                        >
                          <span>{commit.shortSha}</span>
                          <span>&middot;</span>
                          <span>{commit.author || 'Unknown author'}</span>
                          <span>&middot;</span>
                          <span>{formatRelativeTime(commit.date)}</span>
                          <span>&middot;</span>
                          <span style={{ color: '#4ade80' }}>+{commit.additions}</span>
                          <span style={{ color: '#f87171' }}>-{commit.deletions}</span>
                        </div>
                      </div>
                    </button>

                    {isExpanded ? (
                      <div
                        style={{
                          paddingTop: 0,
                          paddingRight: 14,
                          paddingBottom: 14,
                          paddingLeft: 14,
                          borderTop: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        <div
                          style={{
                            paddingTop: 12,
                            paddingRight: 0,
                            paddingBottom: 0,
                            paddingLeft: 0,
                            color: 'rgba(255,255,255,0.78)',
                            fontSize: 12,
                            lineHeight: 1.6,
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {commit.body || commit.message}
                        </div>

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                            marginTop: 12,
                          }}
                        >
                          <ActionButton
                            icon={<CopyIcon size={12} color="#cbd5e1" />}
                            label={copiedCommitSha === commit.sha ? 'Copied!' : 'Copy SHA'}
                            onClick={() => void handleCopySha(commit.sha)}
                          />
                          <ActionButton
                            icon={<ExternalLinkIcon size={12} color={repoSlug ? '#cbd5e1' : 'rgba(255,255,255,0.3)'} />}
                            label="View on GitHub"
                            onClick={() => handleViewOnGitHub(commit.sha)}
                            disabled={!repoSlug}
                          />
                        </div>

                        <div style={{ marginTop: 16 }}>
                          {diffLoading ? (
                            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Loading commit diff...</div>
                          ) : diffError ? (
                            <div style={{ color: '#fca5a5', fontSize: 12 }}>{diffError}</div>
                          ) : commitDiffFiles.length === 0 ? (
                            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>No file diff available</div>
                          ) : (
                            commitDiffFiles.map((file) => (
                              <div
                                key={`${commit.sha}:${file.path}`}
                                style={{
                                  paddingTop: 12,
                                  paddingRight: 0,
                                  paddingBottom: 0,
                                  paddingLeft: 0,
                                  borderTop: '1px solid rgba(255,255,255,0.06)',
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <span
                                    style={{
                                      flex: 1,
                                      minWidth: 0,
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                      color: file.status === 'added'
                                        ? '#4ade80'
                                        : file.status === 'deleted'
                                          ? '#f87171'
                                          : '#e2e8f0',
                                      fontSize: 12,
                                      fontWeight: 600,
                                      fontFamily: '"SF Mono", ui-monospace, monospace',
                                    }}
                                  >
                                    {file.path}
                                  </span>
                                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                                    {file.status === 'renamed' && file.previousPath ? `from ${file.previousPath}` : file.status}
                                  </span>
                                  <span style={{ fontSize: 11, fontWeight: 600, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                                    <span style={{ color: '#4ade80' }}>+{file.additions}</span>
                                    {' '}
                                    <span style={{ color: '#f87171' }}>-{file.deletions}</span>
                                  </span>
                                </div>
                                <DiffBlock diff={file.diff} />
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )
        ) : files.length === 0 ? (
          <div style={{ paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24, color: 'rgba(255,255,255,0.4)', fontSize: 13, textAlign: 'center' }}>
            {filter === 'branch' ? 'No branch changes' : `No ${filterLabel(filter).toLowerCase()} changes`}
          </div>
        ) : (
          files.map((file) => {
            const isExpanded = expandedFile === file.path;

            return (
              <div key={file.path}>
                <button
                  type="button"
                  onClick={() => void handleFileClick(file.path)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    paddingTop: 6,
                    paddingRight: 12,
                    paddingBottom: 6,
                    paddingLeft: 12,
                    border: 'none',
                    background: isExpanded ? 'rgba(59,130,246,0.12)' : 'transparent',
                    color: 'rgba(255,255,255,0.85)',
                    fontSize: 12,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    cursor: 'pointer',
                    textAlign: 'left',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                  }}
                  onMouseEnter={(event) => {
                    if (isExpanded) return;
                    event.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                  }}
                  onMouseLeave={(event) => {
                    if (isExpanded) return;
                    event.currentTarget.style.background = 'transparent';
                  }}
                >
                  <ChevronIcon open={isExpanded} size={10} color="rgba(255,255,255,0.7)" />
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: file.status === 'added'
                        ? '#4ade80'
                        : file.status === 'deleted'
                          ? '#f87171'
                          : 'rgba(255,255,255,0.85)',
                    }}
                  >
                    {file.path}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                    {file.additions > 0 ? <span style={{ color: '#4ade80' }}>+{file.additions}</span> : null}
                    {file.additions > 0 && file.deletions > 0 ? ' ' : null}
                    {file.deletions > 0 ? <span style={{ color: '#f87171' }}>-{file.deletions}</span> : null}
                  </span>
                </button>
                {isExpanded && expandedDiff ? (
                  <div
                    style={{
                      paddingTop: 0,
                      paddingRight: 0,
                      paddingBottom: 0,
                      paddingLeft: 0,
                      borderBottom: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <DiffBlock diff={expandedDiff} />
                  </div>
                ) : isExpanded ? (
                  <div
                    style={{
                      paddingTop: 12,
                      paddingRight: 16,
                      paddingBottom: 12,
                      paddingLeft: 16,
                      fontSize: 12,
                      color: 'rgba(255,255,255,0.5)',
                      borderBottom: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    Loading diff...
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
