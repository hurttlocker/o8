'use client';

import { memo, useEffect, useState } from 'react';
import { useTheme } from './ThemeContext';

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
    case 'success':
    case 'active':
      return '#30d158';
    case 'failure':
    case 'error':
      return '#ff453a';
    case 'pending':
    case 'in_progress':
    case 'queued':
      return '#ff9f0a';
    case 'inactive':
      return '#8e8e93';
    default:
      return '#8e8e93';
  }
}

function stateLabel(state: string): string {
  switch (state.toLowerCase()) {
    case 'success':
    case 'active':
      return 'Live';
    case 'failure':
    case 'error':
      return 'Failed';
    case 'pending':
    case 'in_progress':
    case 'queued':
      return 'Deploying';
    case 'inactive':
      return 'Inactive';
    default:
      return state;
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
  const { colors } = useTheme();
  const color = stateColor(deploy.state);
  const label = stateLabel(deploy.state);

  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
            boxShadow: `0 0 0 4px ${color}20`,
          }}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>{repoShort(deploy.repo)}</span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {label}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: colors.textSecondary, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
              {deploy.environment}
            </span>
            <span style={{ fontSize: 10, color: colors.textTertiary }}>·</span>
            <span style={{ fontSize: 11, color: colors.textSecondary, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
              {deploy.sha.slice(0, 7)}
            </span>
            <span style={{ fontSize: 10, color: colors.textTertiary }}>·</span>
            <span style={{ fontSize: 11, color: colors.textSecondary }}>{timeAgo(deploy.createdAt)}</span>
          </div>
        </div>

        {deploy.url ? (
          <a
            href={deploy.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: colors.blueGlass,
              border: `1px solid ${colors.blueGlassBorder}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textDecoration: 'none',
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.blueAccent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
  const { colors } = useTheme();
  const [deploys, setDeploys] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const repoList = repos ?? REPOS;

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      Promise.all(
        repoList.map(async (repo) => {
          try {
            const response = await fetch(`/api/panel/deploys?repo=${encodeURIComponent(repo)}`);
            const data = await response.json();
            return (data.deployments ?? []).map((deployment: Omit<Deployment, 'repo'>) => ({
              ...deployment,
              repo,
            }));
          } catch {
            return [];
          }
        })
      ).then((results) => {
        if (cancelled) return;
        const all = results.flat().sort(
          (a: Deployment, b: Deployment) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setDeploys(all);
        setLoading(false);
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [repoList]);

  if (loading) {
    return (
      <div
        style={{
          padding: '32px 20px',
          textAlign: 'center',
          color: colors.textSecondary,
          fontSize: 13,
          borderRadius: 14,
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
        }}
      >
        Loading deployments...
      </div>
    );
  }

  if (deploys.length === 0) {
    return (
      <div
        style={{
          padding: '32px 20px',
          textAlign: 'center',
          color: colors.textSecondary,
          fontSize: 13,
          borderRadius: 14,
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
        }}
      >
        No recent deployments
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {deploys.map((deploy, index) => (
        <DeployCard key={`${deploy.repo}-${deploy.sha}-${index}`} deploy={deploy} />
      ))}
    </div>
  );
}
