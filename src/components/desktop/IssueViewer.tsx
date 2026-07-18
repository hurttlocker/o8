'use client';
/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- extracted from Canvas.tsx */

import { memo, useEffect, useState } from 'react';
import { ExternalLink, Play } from './lucide-shims';
import { MarkdownBody } from './MarkdownBody';
import type { RepoReadiness, RepoRegistryEntry } from '@/lib/repos/types';
import { repoSlugFromRemote, readinessTone, formatAge, LIGHT_CANVAS_VARS, type CanvasRepoTaskLaunchRequest } from './canvas-utils';

interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string; color: string }[];
  author: string;
  createdAt: string;
  comments: number;
  url: string;
}

export const IssueViewer = memo(function IssueViewer({
  issueNumber,
  repo,
  onLaunchWorkspaceTask,
}: {
  issueNumber: number;
  repo?: string;
  onLaunchWorkspaceTask?: (request: CanvasRepoTaskLaunchRequest) => Promise<void>;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [localRepo, setLocalRepo] = useState<Pick<RepoRegistryEntry, 'name' | 'localPath' | 'readiness'> | null>(null);
  const repoMissing = localRepo?.readiness?.state === 'missing';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/issues/${issueNumber}${repoParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setDetail(data.issue ?? data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [issueNumber]);

  useEffect(() => {
    if (!repo) {
      setLocalRepo(null);
      return;
    }
    let cancelled = false;
    fetch('/api/panel/repos')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const match = (data.repos ?? []).find((entry: RepoRegistryEntry) => repoSlugFromRemote(entry.remoteUrl) === repo);
        setLocalRepo(match ? { name: match.name, localPath: match.localPath, readiness: match.readiness } : null);
      })
      .catch(() => {
        if (!cancelled) setLocalRepo(null);
      });
    return () => { cancelled = true; };
  }, [repo]);

  if (loading) {
    return (
      <div style={{ padding: 32, color: 'var(--t-text-muted)', fontSize: 13 }}>
        Loading issue #{issueNumber}...
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div style={{ padding: 32, color: '#ef4444', fontSize: 13 }}>
        Failed to load issue #{issueNumber}: {error || 'Unknown error'}
      </div>
    );
  }

  const stateColor = detail.state === 'open' ? '#34c759' : '#8b5cf6';
  const age = formatAge(detail.createdAt);

  return (
    <div style={{ padding: '24px 32px' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 20,
      }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: stateColor,
          marginTop: 8,
          flexShrink: 0,
        }} />
        <div style={{ flex: 1 }}>
          <h2 style={{
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: '-0.03em',
            color: 'var(--t-text-strong)',
            margin: 0,
            lineHeight: 1.3,
          }}>
            #{detail.number} {detail.title}
          </h2>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 8,
            fontSize: 12,
            color: 'var(--t-text-muted)',
          }}>
            <span>{detail.author}</span>
            <span>·</span>
            <span>{age}</span>
            <span>·</span>
            <span>{detail.comments} comment{detail.comments !== 1 ? 's' : ''}</span>
            <a
              href={detail.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                color: 'var(--t-text-secondary)',
                textDecoration: 'none',
                marginLeft: 'auto',
              }}
            >
              <ExternalLink size={12} />
              GitHub
            </a>
          </div>
          {/* Labels */}
          {detail.labels.length > 0 && (
            <div style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              marginTop: 10,
            }}>
              {detail.labels.map((l) => (
                <span
                  key={l.name}
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    padding: '2px 8px',
                    borderRadius: 6,
                    backgroundColor: `#${l.color}18`,
                    color: `#${l.color}`,
                    border: `1px solid #${l.color}30`,
                  }}
                >
                  {l.name}
                </span>
              ))}
            </div>
          )}
          {repo && onLaunchWorkspaceTask ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
              {localRepo?.readiness ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: `1px solid ${readinessTone(localRepo.readiness).border}`,
                    background: readinessTone(localRepo.readiness).background,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: readinessTone(localRepo.readiness).color }}>
                      {localRepo.name} · {localRepo.readiness.label}
                    </span>
                    {localRepo.readiness.currentBranch ? (
                      <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                        {localRepo.readiness.currentBranch}
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--t-text-secondary)' }}>
                    {localRepo.readiness.summary}
                  </div>
                  {localRepo.readiness.nextAction ? (
                    <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>
                      {localRepo.readiness.nextAction}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={launching || repoMissing}
                onClick={() => {
                  setLaunching(true);
                  void onLaunchWorkspaceTask({
                    kind: 'issue',
                    repo,
                    number: detail.number,
                    title: detail.title,
                    body: detail.body,
                  }).finally(() => setLaunching(false));
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 44,
                  padding: '0 12px',
                  borderRadius: 10,
                  border: '1px solid rgba(37, 99, 235, 0.18)',
                  background: 'rgba(37, 99, 235, 0.08)',
                  color: launching || repoMissing ? 'var(--t-text-faint)' : 'var(--t-accent)',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: launching || repoMissing ? 'default' : 'pointer',
                }}
              >
                <Play size={13} />
                {repoMissing ? 'Folder missing' : launching ? 'Launching…' : 'Launch In Workspace'}
              </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div style={{
        background: 'rgba(249,250,251,0.9)',
        borderRadius: 14,
        padding: '20px 24px',
        border: '1px solid #f3f4f6',
        fontSize: 14,
        lineHeight: 1.65,
        color: '#111827',
        letterSpacing: '-0.01em',
        ...LIGHT_CANVAS_VARS,
      }}>
        <MarkdownBody text={detail.body || '*No description.*'} />
      </div>
    </div>
  );
});
