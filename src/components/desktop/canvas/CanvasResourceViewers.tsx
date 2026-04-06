'use client';
/* eslint-disable react-hooks/set-state-in-effect, @next/next/no-img-element -- preserved from legacy Canvas.tsx extraction */

import { memo, useEffect, useState } from 'react';
import { FileText, GitCommit, Globe } from 'lucide-react';
import { MarkdownBody } from '@/components/desktop/MarkdownBody';
import { formatAge } from '@/components/desktop/canvas-utils';

interface GitLogCommit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  refs: { type: string; name: string }[];
}

function GitLogViewerBase({
  workspace,
  onSelectCommit,
}: {
  workspace: string;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
}) {
  const [commits, setCommits] = useState<GitLogCommit[]>([]);
  const [currentBranch, setCurrentBranch] = useState('main');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const wsParam = workspace ? `?workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/git-log${wsParam}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setCommits(data.commits ?? []);
          setCurrentBranch(data.currentBranch ?? 'main');
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading git log…</div>;
  }

  if (commits.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>No commits found</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          paddingTop: 12,
          paddingRight: 20,
          paddingBottom: 10,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <GitCommit size={16} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>Git History</span>
        <span
          style={{
            fontSize: 11,
            fontFamily: '"SF Mono", ui-monospace, monospace',
            paddingTop: 2,
            paddingRight: 8,
            paddingBottom: 2,
            paddingLeft: 8,
            borderRadius: 99,
            background: 'rgba(59,130,246,0.08)',
            color: '#3b82f6',
            fontWeight: 600,
          }}
        >
          {currentBranch}
        </span>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)', marginLeft: 'auto' }}>{commits.length} commits</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {commits.map((commit, i) => (
          <button
            key={commit.hash}
            type="button"
            onClick={() => onSelectCommit?.(commit.hash, workspace ? { workspace } : undefined)}
            style={{
              display: 'flex',
              gap: 12,
              width: '100%',
              paddingTop: 10,
              paddingRight: 20,
              paddingBottom: 10,
              paddingLeft: 20,
              border: 'none',
              borderBottom: '1px solid var(--t-divider-subtle)',
              background: 'transparent',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: '-apple-system, system-ui, sans-serif',
              transition: 'background 80ms ease',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: 20,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                flexShrink: 0,
                position: 'relative',
              }}
            >
              {i > 0 ? (
                <div style={{ position: 'absolute', top: 0, width: 2, height: 10, background: 'var(--t-divider)' }} />
              ) : null}
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  background: commit.refs.some((r) => r.type === 'head') ? '#3b82f6' : 'var(--t-text-faint)',
                  border: commit.refs.some((r) => r.type === 'head')
                    ? '2px solid rgba(59,130,246,0.3)'
                    : '2px solid var(--t-divider-subtle)',
                  marginTop: 6,
                  flexShrink: 0,
                  zIndex: 1,
                }}
              />
              {i < commits.length - 1 ? (
                <div style={{ width: 2, flex: 1, background: 'var(--t-divider)', marginTop: 2 }} />
              ) : null}
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 400,
                    color: 'var(--t-text-strong)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {commit.subject}
                </span>

                {commit.refs.map((ref, j) => (
                  <span
                    key={j}
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      paddingTop: 1,
                      paddingRight: 6,
                      paddingBottom: 1,
                      paddingLeft: 6,
                      borderRadius: 4,
                      flexShrink: 0,
                      ...(ref.type === 'head'
                        ? { color: '#3b82f6', background: 'rgba(59,130,246,0.08)' }
                        : ref.type === 'tag'
                          ? { color: '#f59e0b', background: 'rgba(245,158,11,0.08)' }
                          : { color: 'var(--t-text-muted)', background: 'var(--t-hover)' }),
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                    }}
                  >
                    {ref.name}
                  </span>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, fontSize: 11, color: 'var(--t-text-muted)' }}>
                <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 11, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
                  {commit.shortHash}
                </span>
                <span>{commit.author}</span>
                <span>·</span>
                <span>{formatAge(commit.date)}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export const GitLogViewer = memo(GitLogViewerBase);

function ImagePreviewBase({ filePath, workspace }: { filePath: string; workspace?: string }) {
  const [imageData, setImageData] = useState<{
    type: string;
    dataUrl?: string;
    content?: string;
    mimeType: string;
    size: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const wsParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';
    fetch(`/api/panel/file-preview?path=${encodeURIComponent(filePath)}${wsParam}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          if (data.error) {
            setError(data.error);
          } else {
            setImageData(data);
          }
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Failed to load image');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, workspace]);

  const fileName = filePath.split('/').pop() ?? filePath;

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading image…</div>;
  }

  if (error || !imageData) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#ef4444' }}>{error || 'Could not load image'}</div>;
  }

  const sizeLabel = imageData.size < 1024
    ? `${imageData.size} B`
    : imageData.size < 1024 * 1024
      ? `${(imageData.size / 1024).toFixed(1)} KB`
      : `${(imageData.size / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          paddingTop: 12,
          paddingRight: 20,
          paddingBottom: 10,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <FileText size={16} strokeWidth={1.8} style={{ color: 'var(--t-text-muted)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>{fileName}</span>
        <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{imageData.mimeType} · {sizeLabel}</span>
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
          paddingTop: 24,
          paddingRight: 24,
          paddingBottom: 24,
          paddingLeft: 24,
          background: 'repeating-conic-gradient(rgba(0,0,0,0.04) 0% 25%, transparent 0% 50%) 50% / 16px 16px',
        }}
      >
        {imageData.type === 'svg' && imageData.content ? (
          <div
            dangerouslySetInnerHTML={{ __html: imageData.content }}
            style={{ maxWidth: '100%', maxHeight: '100%' }}
          />
        ) : imageData.dataUrl ? (
          <img
            src={imageData.dataUrl}
            alt={fileName}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 4,
              boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export const ImagePreview = memo(ImagePreviewBase);

interface VercelDeploy {
  uid: string;
  name: string;
  url: string;
  state: string;
  created: number;
  ready?: number;
  meta?: {
    githubCommitSha?: string;
    githubCommitMessage?: string;
    githubCommitRef?: string;
    githubCommitAuthorLogin?: string;
  };
  target?: string;
  inspectorUrl?: string;
}

function deployColor(state: string): string {
  switch (state.toUpperCase()) {
    case 'READY':
      return '#22c55e';
    case 'BUILDING':
    case 'INITIALIZING':
      return '#f59e0b';
    case 'ERROR':
    case 'CANCELED':
      return '#ef4444';
    case 'QUEUED':
      return '#94a3b8';
    default:
      return '#64748b';
  }
}

function deployIcon(state: string): string {
  switch (state.toUpperCase()) {
    case 'READY':
      return '●';
    case 'BUILDING':
    case 'INITIALIZING':
      return '◉';
    case 'ERROR':
      return '✗';
    case 'CANCELED':
      return '⊘';
    case 'QUEUED':
      return '○';
    default:
      return '○';
  }
}

function DeployViewerBase({ project }: { project?: string }) {
  const [deploys, setDeploys] = useState<VercelDeploy[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = project ? `?project=${encodeURIComponent(project)}` : '';
    fetch(`/api/panel/deployments${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setDeploys(data.deployments ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading deployments…</div>;
  }

  if (deploys.length === 0) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>No deployments found</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          paddingTop: 12,
          paddingRight: 20,
          paddingBottom: 10,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <Globe size={16} strokeWidth={1.8} style={{ color: 'var(--t-text-secondary)' }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>Deployments</span>
        {project ? (
          <span style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>{project}</span>
        ) : null}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {deploys.map((deploy) => {
          const color = deployColor(deploy.state);
          const icon = deployIcon(deploy.state);
          const isProduction = deploy.target === 'production';
          const commitMsg = deploy.meta?.githubCommitMessage ?? '';
          const commitSha = deploy.meta?.githubCommitSha?.slice(0, 7) ?? '';
          const branch = deploy.meta?.githubCommitRef ?? '';
          const author = deploy.meta?.githubCommitAuthorLogin ?? '';
          const age = formatAge(new Date(deploy.created).toISOString());

          return (
            <div
              key={deploy.uid}
              style={{
                display: 'flex',
                gap: 12,
                paddingTop: 12,
                paddingRight: 20,
                paddingBottom: 12,
                paddingLeft: 20,
                borderBottom: '1px solid var(--t-divider-subtle)',
              }}
            >
              <span
                style={{
                  fontSize: 16,
                  color,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  flexShrink: 0,
                  marginTop: 2,
                }}
              >
                {icon}
              </span>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <a
                    href={`https://${deploy.url}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--t-text-strong)',
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {deploy.url}
                  </a>
                  {isProduction ? (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 700,
                        paddingTop: 1,
                        paddingRight: 5,
                        paddingBottom: 1,
                        paddingLeft: 5,
                        borderRadius: 3,
                        background: 'rgba(34,197,94,0.08)',
                        color: '#22c55e',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Production
                    </span>
                  ) : null}
                  <span
                    style={{
                      fontSize: 10,
                      paddingTop: 1,
                      paddingRight: 5,
                      paddingBottom: 1,
                      paddingLeft: 5,
                      borderRadius: 3,
                      color,
                      background: `${color}10`,
                      fontWeight: 600,
                    }}
                  >
                    {deploy.state.toLowerCase()}
                  </span>
                </div>

                {commitMsg ? (
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--t-text-secondary)',
                      marginTop: 4,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {commitMsg}
                  </div>
                ) : null}

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>
                  {branch ? (
                    <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10 }}>{branch}</span>
                  ) : null}
                  {commitSha ? (
                    <>
                      <span>·</span>
                      <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: 10, color: 'var(--t-text-secondary)' }}>{commitSha}</span>
                    </>
                  ) : null}
                  {author ? (
                    <>
                      <span>·</span>
                      <span>{author}</span>
                    </>
                  ) : null}
                  <span>·</span>
                  <span>{age}</span>
                  {deploy.inspectorUrl ? (
                    <>
                      <span>·</span>
                      <a
                        href={deploy.inspectorUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#3b82f6', textDecoration: 'none', fontSize: 10 }}
                      >
                        Inspect ↗
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const DeployViewer = memo(DeployViewerBase);

function ReadmeViewerBase({ workspace }: { workspace: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/panel/readme?workspace=${encodeURIComponent(workspace)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setContent(data.content);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  if (loading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>Loading README…</div>;
  }

  if (!content) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>No README found in this workspace</div>;
  }

  return (
    <div style={{ paddingTop: 24, paddingRight: 32, paddingBottom: 24, paddingLeft: 32, overflowY: 'auto', height: '100%' }}>
      <MarkdownBody text={content} />
    </div>
  );
}

export const ReadmeViewer = memo(ReadmeViewerBase);
