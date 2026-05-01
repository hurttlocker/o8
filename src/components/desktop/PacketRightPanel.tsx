'use client';

/**
 * PacketRightPanel — packet-mode view of the right-side workspace panel.
 *
 * Renders when a packet is expanded in the orchestrator's mission rail
 * (see `derivePanelMode` in `src/lib/panel/mode.ts`). Three tabs:
 *
 *   - SPEC          — re-uses the editable spec.md surface (#773).
 *   - AGENT OVERVIEW — lane / sub-agent summary for the selected packet.
 *   - CHANGES        — proxy to the existing right-panel Changes tab so
 *                      the packet-tab "Changes N" link from #893 has a
 *                      single render path.
 *
 * Style follows the o8 Rams language: paper-and-ink, Plus Jakarta Sans,
 * Issues-style uppercase tab labels, one orange accent for the active
 * tab. No native form controls, no hardcoded rgba surfaces.
 */

import { useMemo, useState } from 'react';
import type {
  OrchestratorMissionState,
  OrchestratorPacket,
} from '@/lib/orchestrator/types';
import type { WorkspaceSidePanelRepo } from '@/components/desktop/WorkspaceSidePanel';
import { PacketSpecEditor } from '@/components/desktop/thoughts/mission-panel/PacketSpecEditor';
import { ChangesTab } from '@/components/desktop/workspace-side-panel/ChangesTab';
import { orchestratorRuntimeTone, orchestratorStatusTone } from '@/lib/orchestrator/display';
import { AmbientPanel } from '@/components/desktop/right-panel/AmbientPanel';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import type { AmbientLinkedRef, AmbientSelectedFile } from '@/components/desktop/right-panel/useAmbientMode';

type TabId = 'spec' | 'agent-overview' | 'changes';

interface PacketRightPanelProps {
  selectedPacketId?: string | null;
  missionState: OrchestratorMissionState;
  agents?: FleetAgent[];
  workspaceSidePanelRepo: WorkspaceSidePanelRepo | null;
  focusedRepoPath?: string | null;
  selectedFile?: AmbientSelectedFile | null;
  selectedIssue?: AmbientLinkedRef | null;
  selectedPR?: AmbientLinkedRef | null;
  onClose: () => void;
  onOpenFile: (path: string, repo: WorkspaceSidePanelRepo | null) => void;
}

export function PacketRightPanel({
  selectedPacketId,
  missionState,
  agents,
  workspaceSidePanelRepo,
  focusedRepoPath,
  selectedFile,
  selectedIssue,
  selectedPR,
}: PacketRightPanelProps) {
  return (
    <AmbientPanel
      selectedPacketId={selectedPacketId}
      missionState={missionState}
      agents={agents}
      focusedRepoPath={focusedRepoPath ?? workspaceSidePanelRepo?.localPath ?? null}
      selectedFile={selectedFile}
      selectedIssue={selectedIssue}
      selectedPR={selectedPR}
    />
  );
}

export function PacketRightPanelLegacy({
  selectedPacketId,
  missionState,
  workspaceSidePanelRepo,
  onClose,
  onOpenFile,
}: PacketRightPanelProps) {
  const packet = useMemo<OrchestratorPacket | null>(
    () => missionState.packets.find((candidate) => candidate.id === selectedPacketId) ?? null,
    [missionState.packets, selectedPacketId],
  );
  const [activeTab, setActiveTab] = useState<TabId>('spec');

  if (!packet) {
    return (
      <div
        data-chrome-surface="true"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--t-text-muted)',
          fontSize: 12,
          background: 'transparent',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
      >
        Packet unavailable.
      </div>
    );
  }

  const statusMeta = orchestratorStatusTone(packet.status);
  const runtimeMeta = orchestratorRuntimeTone(packet.runtime);

  return (
    <div
      data-chrome-surface="true"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'transparent',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 10,
          paddingRight: 12,
          paddingBottom: 10,
          paddingLeft: 12,
          borderBottomWidth: '0.5px',
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: statusMeta.color,
            flexShrink: 0,
          }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: 'var(--t-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              letterSpacing: '-0.01em',
            }}
            title={packet.title}
          >
            {packet.title}
          </div>
          <div
            style={{
              marginTop: 2,
              fontSize: 11,
              color: 'var(--t-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {runtimeMeta.label}
            {packet.referenceLabel ? (
              <>
                {' · '}
                <span style={{ fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)' }}>
                  {packet.referenceLabel}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close packet panel"
          aria-label="Close packet panel"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 8,
            borderWidth: 0,
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      {/* Tab strip — Issues-style uppercase, one orange accent */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          paddingTop: 6,
          paddingRight: 8,
          paddingBottom: 6,
          paddingLeft: 8,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      >
        <PanelModeTab
          active={activeTab === 'spec'}
          label="Spec"
          onClick={() => setActiveTab('spec')}
        />
        <PanelModeTab
          active={activeTab === 'agent-overview'}
          label="Agent Overview"
          onClick={() => setActiveTab('agent-overview')}
        />
        <PanelModeTab
          active={activeTab === 'changes'}
          label="Changes"
          onClick={() => setActiveTab('changes')}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {activeTab === 'spec' ? (
          <div style={{ paddingTop: 6, paddingRight: 6, paddingBottom: 12, paddingLeft: 6 }}>
            <PacketSpecEditor packetId={packet.id} />
          </div>
        ) : null}
        {activeTab === 'agent-overview' ? (
          <PacketAgentOverview packet={packet} />
        ) : null}
        {activeTab === 'changes' ? (
          <ChangesTab repo={workspaceSidePanelRepo} onOpenFile={onOpenFile} />
        ) : null}
      </div>
    </div>
  );
}

interface PanelModeTabProps {
  active: boolean;
  label: string;
  onClick: () => void;
}

function PanelModeTab({ active, label, onClick }: PanelModeTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        height: 26,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        borderRadius: 8,
        borderWidth: 0,
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: active ? 'var(--t-accent)' : 'var(--t-text-muted)',
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        cursor: 'pointer',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.color = 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.color = 'var(--t-text-muted)';
      }}
    >
      {label}
    </button>
  );
}

interface PacketAgentOverviewProps {
  packet: OrchestratorPacket;
}

function PacketAgentOverview({ packet }: PacketAgentOverviewProps) {
  const lane = packet.lane;
  const runtimeMeta = orchestratorRuntimeTone(packet.runtime);
  const statusMeta = orchestratorStatusTone(packet.status);

  const rows: Array<{ label: string; value: string | null; mono?: boolean }> = [
    { label: 'Status', value: statusMeta.label },
    { label: 'Runtime', value: runtimeMeta.label },
    { label: 'Branch', value: packet.branchTarget || null },
    { label: 'Repo', value: packet.workspaceTargetPath, mono: true },
    { label: 'Lane', value: lane?.laneId ? lane.laneId.slice(0, 16) : null, mono: true },
    { label: 'Session', value: lane?.sessionKey ? lane.sessionKey.slice(0, 16) : null, mono: true },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 4,
      }}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            paddingTop: 8,
            paddingRight: 14,
            paddingBottom: 8,
            paddingLeft: 14,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: 'var(--t-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              width: 92,
              flexShrink: 0,
            }}
          >
            {row.label}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11.5,
              color: row.value ? 'var(--t-text)' : 'var(--t-text-faint)',
              fontFamily: row.mono ? 'var(--font-mono, "SF Mono", Menlo, monospace)' : undefined,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              wordBreak: 'break-all',
            }}
          >
            {row.value ?? '—'}
          </span>
        </div>
      ))}

      {packet.summary ? (
        <div
          style={{
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: 'var(--t-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 6,
            }}
          >
            Summary
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--t-text)',
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
            }}
          >
            {packet.summary}
          </div>
        </div>
      ) : null}
    </div>
  );
}
