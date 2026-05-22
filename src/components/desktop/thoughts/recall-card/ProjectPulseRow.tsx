'use client';

/**
 * #899 wave 2 — PROJECT PULSE row of the Context Recall Card.
 *
 * Aggregates activity from peer repos in every Project the packet's repo
 * belongs to. Surfaces:
 *   - recent commits (last 24h, max 5 per repo)
 *   - open PRs (max 5 per repo)
 *   - open issues (max 5 per repo)
 *
 * Hidden entirely when the repo isn't in any project (the parent guards on
 * `pulses.length > 0` before mounting this row).
 */

import { useMemo } from 'react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  Chevron,
  expandedSurfaceStyle,
  FONT_FAMILY,
  formatRelative,
  rowChromeStyle,
  rowLabelStyle,
  rowValueStyle,
} from './shared';
import type {
  ProjectPulse,
  ProjectPulseRepo,
  PulseCommit,
  PulseIssue,
  PulsePullRequest,
} from '@/lib/projects/pulse';

interface ProjectPulseRowProps {
  open: boolean;
  onToggle: () => void;
  loading: boolean;
  pulses: ProjectPulse[];
}

function openExternal(url: string | null | undefined) {
  if (!url) return;
  if (typeof window === 'undefined') return;
  openExternalUrl(url);
}

function summarizeRepo(repo: ProjectPulseRepo): string | null {
  const parts: string[] = [];
  if (repo.recentCommits.length > 0) {
    const author = repo.recentCommits[0].author;
    const verb = author ? `${author} pushed` : 'pushed';
    parts.push(`${verb} ${repo.recentCommits.length} in ${repo.repoName}`);
  }
  if (repo.openPrs.length > 0) {
    parts.push(`${repo.openPrs.length} open PR${repo.openPrs.length === 1 ? '' : 's'} in ${repo.repoName}`);
  }
  if (repo.openIssues.length > 0 && repo.recentCommits.length === 0 && repo.openPrs.length === 0) {
    parts.push(`${repo.openIssues.length} open issue${repo.openIssues.length === 1 ? '' : 's'} in ${repo.repoName}`);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

function summarizePulses(pulses: ProjectPulse[]): string {
  const fragments: string[] = [];
  for (const pulse of pulses) {
    for (const repo of pulse.byRepo) {
      const piece = summarizeRepo(repo);
      if (piece) fragments.push(piece);
    }
  }
  if (fragments.length === 0) return 'No peer-repo activity in cache yet';
  // Cap at 3 fragments so the collapsed row stays single-line.
  const head = fragments.slice(0, 3).join('; ');
  const remainder = fragments.length - 3;
  return remainder > 0 ? `${head} (+${remainder} more)` : head;
}

export function ProjectPulseRow({ open, onToggle, loading, pulses }: ProjectPulseRowProps) {
  const summary = useMemo(() => {
    if (loading) return 'Gathering project pulse…';
    return summarizePulses(pulses);
  }, [loading, pulses]);

  const totalRepos = useMemo(
    () => pulses.reduce((acc, p) => acc + p.byRepo.length, 0),
    [pulses],
  );

  return (
    <div
      data-packet-row
      style={{
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          ...rowChromeStyle,
          background: open ? 'var(--t-divider-subtle)' : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = 'var(--t-divider-subtle)';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={rowLabelStyle}>pulse</span>
        <span
          style={{
            ...rowValueStyle,
            color: totalRepos > 0 ? 'var(--t-text)' : 'var(--t-text-muted)',
          }}
        >
          {summary}
        </span>
        {totalRepos > 0 ? (
          <span
            style={{
              fontSize: 9.5,
              color: 'var(--t-text-faint)',
              letterSpacing: '0.02em',
              flexShrink: 0,
              paddingRight: 4,
            }}
          >
            {totalRepos} repo{totalRepos === 1 ? '' : 's'}
          </span>
        ) : null}
        <Chevron open={open} />
      </button>
      {open ? (
        <div style={{ ...expandedSurfaceStyle, gap: 10 }}>
          {pulses.map((pulse) => (
            <ProjectBlock key={pulse.projectId} pulse={pulse} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProjectBlock({ pulse }: { pulse: ProjectPulse }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--t-text-muted)',
        }}
      >
        {pulse.projectName}
      </div>
      {pulse.byRepo.map((repo) => (
        <RepoBlock key={repo.repoId} repo={repo} />
      ))}
    </div>
  );
}

function RepoBlock({ repo }: { repo: ProjectPulseRepo }) {
  const isEmpty =
    repo.recentCommits.length === 0 &&
    repo.openPrs.length === 0 &&
    repo.openIssues.length === 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        paddingTop: 4,
        paddingBottom: 4,
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          fontFamily: FONT_FAMILY,
          fontSize: 10.5,
          color: 'var(--t-text)',
        }}
      >
        <span style={{ fontWeight: 600 }}>{repo.repoName}</span>
        {repo.role ? (
          <span
            style={{
              fontSize: 9,
              color: 'var(--t-text-faint)',
              letterSpacing: '0.02em',
              textTransform: 'uppercase',
            }}
          >
            {repo.role}
          </span>
        ) : null}
      </div>
      {isEmpty ? (
        <div
          style={{
            fontFamily: FONT_FAMILY,
            fontSize: 10,
            color: 'var(--t-text-faint)',
            letterSpacing: '0.01em',
          }}
        >
          No cached activity
        </div>
      ) : null}
      {repo.recentCommits.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {repo.recentCommits.map((commit) => (
            <CommitLine key={commit.hash} commit={commit} />
          ))}
        </div>
      ) : null}
      {repo.openPrs.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {repo.openPrs.map((pr) => (
            <PrLine key={pr.number} pr={pr} />
          ))}
        </div>
      ) : null}
      {repo.openIssues.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {repo.openIssues.map((issue) => (
            <IssueLine key={issue.number} issue={issue} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CommitLine({ commit }: { commit: PulseCommit }) {
  const handleClick = () => openExternal(commit.url);
  const clickable = Boolean(commit.url);
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!clickable}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        textAlign: 'left',
        background: 'transparent',
        borderWidth: 0,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        cursor: clickable ? 'pointer' : 'default',
        fontFamily: FONT_FAMILY,
        fontSize: 10,
        color: 'var(--t-text)',
        lineHeight: 1.4,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: 'var(--t-text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          flexShrink: 0,
          width: 38,
        }}
      >
        commit
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {commit.message || commit.hash}
      </span>
      <span
        style={{
          fontSize: 9.5,
          color: 'var(--t-text-faint)',
          letterSpacing: '0.02em',
          flexShrink: 0,
        }}
      >
        {commit.author ? `${commit.author} · ` : ''}
        {formatRelative(commit.date)}
      </span>
    </button>
  );
}

function PrLine({ pr }: { pr: PulsePullRequest }) {
  const handleClick = () => openExternal(pr.url);
  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        textAlign: 'left',
        background: 'transparent',
        borderWidth: 0,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        cursor: 'pointer',
        fontFamily: FONT_FAMILY,
        fontSize: 10,
        color: 'var(--t-text)',
        lineHeight: 1.4,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: 'var(--t-text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          flexShrink: 0,
          width: 38,
        }}
      >
        pr #{pr.number}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {pr.title}
      </span>
      <span
        style={{
          fontSize: 9.5,
          color: 'var(--t-text-faint)',
          letterSpacing: '0.02em',
          flexShrink: 0,
        }}
      >
        {pr.author ? `${pr.author} · ` : ''}
        {formatRelative(pr.updatedAt)}
      </span>
    </button>
  );
}

function IssueLine({ issue }: { issue: PulseIssue }) {
  const handleClick = () => openExternal(issue.url);
  const labelText = issue.labels.length > 0
    ? issue.labels.slice(0, 2).map((l) => l.name).join(', ')
    : null;
  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        textAlign: 'left',
        background: 'transparent',
        borderWidth: 0,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        cursor: 'pointer',
        fontFamily: FONT_FAMILY,
        fontSize: 10,
        color: 'var(--t-text)',
        lineHeight: 1.4,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: 'var(--t-text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          flexShrink: 0,
          width: 38,
        }}
      >
        iss #{issue.number}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {issue.title}
      </span>
      {labelText ? (
        <span
          style={{
            fontSize: 9.5,
            color: 'var(--t-text-faint)',
            letterSpacing: '0.02em',
            flexShrink: 0,
          }}
        >
          {labelText}
        </span>
      ) : null}
    </button>
  );
}
