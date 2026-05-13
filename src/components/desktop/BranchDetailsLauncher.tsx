'use client';

import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const ROW_HEIGHT = 32;

function pickActivePacket(packets: OrchestratorPacket[] | undefined, selectedId: string | null | undefined): OrchestratorPacket | null {
  if (!packets || packets.length === 0) return null;
  if (selectedId) {
    const hit = packets.find((p) => p.id === selectedId);
    if (hit) return hit;
  }
  const priority: Record<string, number> = {
    awaiting_review: 4,
    running: 3,
    dispatched: 2,
    blocked: 1,
  };
  const ranked = [...packets].sort((a, b) => (priority[b.status] ?? 0) - (priority[a.status] ?? 0));
  const top = ranked[0];
  if (!top) return null;
  if ((priority[top.status] ?? 0) === 0) return null;
  return top;
}

export function BranchDetailsLauncher() {
  const data = useOrchestratorData();

  const activePacket = useMemo(
    () => pickActivePacket(data?.missionState?.packets, data?.selectedPacketId),
    [data?.missionState?.packets, data?.selectedPacketId],
  );

  if (!data || data.o8PanelVisible) return null;
  if (!activePacket) return null;

  const branch = activePacket.branchTarget || 'branch';
  const repoPath = activePacket.workspaceTargetPath ?? null;

  const open = (tab: NonNullable<Parameters<NonNullable<typeof data.onOpenO8Panel>>[0]['tab']>) => {
    data.onOpenO8Panel?.({ repoPath, tab });
  };

  return (
    <aside
      style={{
        width: 256,
        flexShrink: 0,
        paddingTop: 14,
        paddingRight: 14,
        paddingBottom: 14,
        paddingLeft: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      <Card>
        <Header label="Branch details" hint={branch} />
        <Row icon={<DiffIcon />} label="Changes" onClick={() => open('prs')} />
        <Row icon={<BranchIcon />} label="Git actions" onClick={() => open('workspace')} />
        <Row icon={<GhIcon />} label="Create pull request" onClick={() => open('prs')} />
      </Card>

      <Card>
        <Header label="Artifacts" />
        <ArtifactsBody repoPath={repoPath} onOpenBrowser={() => open('browser')} />
      </Card>

      <Card>
        <Header label="Sources" />
        <Row icon={<SquaresIcon />} label="Playwright" onClick={() => open('browser')} muted />
        <Row icon={<SquaresIcon />} label="Chrome Devtools" onClick={() => open('browser')} muted />
      </Card>
    </aside>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        borderRadius: 14,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border-subtle, var(--t-border))',
        background: 'var(--t-bg-card)',
        paddingTop: 10,
        paddingBottom: 6,
        paddingLeft: 4,
        paddingRight: 4,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}

function Header({ label, hint }: { label: string; hint?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingLeft: 10,
        paddingRight: 10,
        paddingBottom: 8,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        color: 'var(--t-text-muted)',
      }}
    >
      <span>{label}</span>
      {hint ? (
        <span
          style={{
            fontWeight: 500,
            color: 'var(--t-text-muted)',
            opacity: 0.6,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
            textAlign: 'right',
          }}
          title={hint}
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const ROW_BASE: CSSProperties = {
  height: ROW_HEIGHT,
  paddingLeft: 10,
  paddingRight: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  borderRadius: 8,
  borderWidth: 0,
  background: 'transparent',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: '-0.005em',
  color: 'var(--t-text)',
  fontFamily: 'inherit',
};

function Row({ icon, label, onClick, muted = false }: { icon: ReactNode; label: string; onClick: () => void; muted?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...ROW_BASE,
        color: muted ? 'var(--t-text-muted)' : 'var(--t-text)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--t-panel-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0, color: muted ? 'var(--t-text-muted)' : 'var(--t-text-secondary)' }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

function ArtifactsBody({ repoPath, onOpenBrowser }: { repoPath: string | null; onOpenBrowser: () => void }) {
  // Placeholder: artifact discovery (running localhost ports inside the
  // packet worktree) is not wired yet. When it lands, replace this stub
  // with the real list of detected URLs.
  void repoPath;
  return (
    <div
      style={{
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 4,
        paddingBottom: 10,
        fontSize: 12,
        color: 'var(--t-text-muted)',
        opacity: 0.7,
        letterSpacing: '-0.005em',
      }}
    >
      <button
        onClick={onOpenBrowser}
        style={{
          ...ROW_BASE,
          paddingLeft: 0,
          paddingRight: 0,
          color: 'var(--t-text-muted)',
          fontWeight: 500,
        }}
      >
        <span style={{ display: 'inline-flex', flexShrink: 0 }}><GlobeIcon /></span>
        <span>Open browser</span>
      </button>
    </div>
  );
}

function svgProps(size = 15): { width: number; height: number; viewBox: string; fill: string; stroke: string; strokeWidth: number; strokeLinecap: 'round'; strokeLinejoin: 'round' } {
  return { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
}

function DiffIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8" />
      <path d="M18 10v2a4 4 0 0 1-4 4H8" />
    </svg>
  );
}

function GhIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M9 19c-4 1.5-4-2-6-2" />
      <path d="M15 21v-3.4a3 3 0 0 0-.84-2.32C17.06 14.92 19 13.46 19 9.5a4.65 4.65 0 0 0-.88-3 4.3 4.3 0 0 0-.12-3s-1-.32-3.3 1.24a11.4 11.4 0 0 0-6 0C6.4 3.16 5.4 3.5 5.4 3.5a4.3 4.3 0 0 0-.12 3A4.65 4.65 0 0 0 4.4 9.5c0 3.95 1.93 5.42 4.84 5.78A3 3 0 0 0 8.4 17.6V21" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function SquaresIcon() {
  return (
    <svg {...svgProps()}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
