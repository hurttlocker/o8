'use client';

import { useState, useEffect, memo } from 'react';

interface Deployment {
  name: string;
  state: string;
  environment: string;
  url?: string;
  createdAt: string;
  sha: string;
  repo: string;
}

interface DeployStatusProps {
  repos?: string[];
}

const REPOS = ['', 'hurttlocker/cortex'];

function stateColor(state: string): string {
  switch (state.toLowerCase()) {
    case 'success': case 'active': return '#34c759';
    case 'failure': case 'error': return '#ff3b30';
    case 'pending': case 'in_progress': case 'queued': return '#ff9f0a';
    case 'inactive': return '#8e8e93';
    default: return '#8e8e93';
  }
}

function stateLabel(state: string): string {
  switch (state.toLowerCase()) {
    case 'success': case 'active': return 'Live';
    case 'failure': case 'error': return 'Failed';
    case 'pending': case 'in_progress': case 'queued': return 'Deploying';
    case 'inactive': return 'Inactive';
    default: return state;
  }
}

function repoShort(repo: string): string {
  const map: Record<string, string> = {
    '': 'Cortex IDE',
    'hurttlocker/cortex': 'Cortex',
    'LavonTMCQ/spear-production': 'Spear',
    'LavonTMCQ/mybeautifulwife': 'Antiflammi',
  };
  return map[repo] ?? repo.split('/').pop() ?? repo;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const DeployCard = memo(function DeployCard({ deploy }: { deploy: Deployment }) {
  const color = stateColor(deploy.state);
  const label = stateLabel(deploy.state);

  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 14,
      background: `${color}06`,
      border: `1px solid ${color}15`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {/* Status dot with optional pulse */}
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: color, flexShrink: 0,
          boxShadow: label === 'Live' ? `0 0 6px ${color}60` : 'none',
          animation: label === 'Deploying' ? 'pulse 1.5s ease-in-out infinite' : 'none',
        }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{
              fontSize: 14, fontWeight: 700, color: '#0a0a0a',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}>
              {repoShort(deploy.repo)}
            </span>
            <span style={{
              fontSize: 10, fontWeight: 700,
              color, textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {label}
            </span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 3,
          }}>
            <span style={{
              fontSize: 11, color: '#8e8e93',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              {deploy.environment}
            </span>
            <span style={{ fontSize: 10, color: '#c7c7cc' }}>·</span>
            <span style={{
              fontSize: 11, color: '#8e8e93',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              {deploy.sha.slice(0, 7)}
            </span>
            <span style={{ fontSize: 10, color: '#c7c7cc' }}>·</span>
            <span style={{ fontSize: 11, color: '#8e8e93' }}>
              {timeAgo(deploy.createdAt)}
            </span>
          </div>
        </div>

        {/* External link */}
        {deploy.url ? (
          <a href={deploy.url} target="_blank" rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 28, height: 28, borderRadius: 8,
              background: 'rgba(0,122,255,0.06)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              textDecoration: 'none',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="#007aff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        ) : null}
      </div>
    </div>
  );
});

export default function DeployStatus({ repos }: DeployStatusProps) {
  const [deploys, setDeploys] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const repoList = repos ?? REPOS;

  useEffect(() => {
    setLoading(true);
    Promise.all(
      repoList.map(async (repo) => {
        try {
          const res = await fetch(`/api/panel/deploys?repo=${encodeURIComponent(repo)}`);
          const data = await res.json();
          return (data.deployments ?? []).map((d: Omit<Deployment, 'repo'>) => ({ ...d, repo }));
        } catch { return []; }
      })
    ).then((results) => {
      const all = results.flat().sort((a: Deployment, b: Deployment) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setDeploys(all);
      setLoading(false);
    });
  }, [repoList]);

  if (loading) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#8e8e93', fontSize: 13 }}>
        Loading deployments...
      </div>
    );
  }

  if (deploys.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: '#8e8e93', fontSize: 13 }}>
        No recent deployments
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {deploys.map((deploy, i) => (
        <DeployCard key={`${deploy.repo}-${deploy.sha}-${i}`} deploy={deploy} />
      ))}
    </div>
  );
}
