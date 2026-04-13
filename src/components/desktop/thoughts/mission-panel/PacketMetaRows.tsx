'use client';

import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import type { OrchestratorPacket, OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import type { EditingField } from './types';

interface PacketMetaRowsProps {
  packet: OrchestratorPacket;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  editingField: EditingField;
  onEditingFieldChange: (next: EditingField) => void;
  onPatch: (updater: (packet: OrchestratorPacket) => OrchestratorPacket) => void;
}

export function PacketMetaRows({
  packet,
  workspaceTargets,
  editingField,
  onEditingFieldChange,
  onPatch,
}: PacketMetaRowsProps) {
  const isEditingSummary = editingField?.packetId === packet.id && editingField.field === 'summary';
  const isEditingRuntime = editingField?.packetId === packet.id && editingField.field === 'runtime';
  const isEditingRepo = editingField?.packetId === packet.id && editingField.field === 'repo';
  const isEditingBranch = editingField?.packetId === packet.id && editingField.field === 'branch';

  const workspaceLabel = packet.workspaceTargetPath
    ? (workspaceTargets.find((t) => t.localPath === packet.workspaceTargetPath)?.label ?? packet.workspaceTargetPath.split('/').pop() ?? 'target')
    : null;

  const runtimeDisplay = packet.runtime === 'claude-code' ? 'Claude Code' : 'Codex';

  const rowChromeStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 28,
    paddingTop: 5,
    paddingRight: 10,
    paddingBottom: 5,
    paddingLeft: 10,
    width: '100%',
    borderWidth: 0,
    background: 'transparent',
    textAlign: 'left' as const,
    cursor: 'pointer',
    transition: 'background 120ms ease',
  };
  const rowLabelStyle: React.CSSProperties = {
    fontSize: 9,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--t-text-muted)',
    width: 58,
    flexShrink: 0,
  };
  const rowValueStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    fontSize: 11.5,
    color: 'var(--t-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    letterSpacing: '-0.005em',
  };
  const chevron = (
    <svg width={9} height={9} viewBox="0 0 10 10" fill="none" stroke="var(--t-text-faint)" strokeWidth="1.5" strokeLinecap="round" style={{ flexShrink: 0, opacity: 0.5 }}>
      <path d="M2.5 3.5L5 6L7.5 3.5" />
    </svg>
  );

  return (
    <>
      {/* Summary row */}
      <div data-packet-row style={{ borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)' }}>
        {isEditingSummary ? (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10 }}>
            <span style={{ ...rowLabelStyle, paddingTop: 4 }}>summary</span>
            <textarea
              autoFocus
              value={packet.summary}
              onChange={(event) => onPatch((current) => ({ ...current, summary: event.target.value }))}
              onBlur={() => onEditingFieldChange(null)}
              placeholder="What should this packet accomplish?"
              rows={3}
              style={{
                flex: 1,
                minWidth: 0,
                paddingTop: 5,
                paddingRight: 8,
                paddingBottom: 5,
                paddingLeft: 8,
                borderRadius: 6,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-accent-border)',
                background: 'var(--t-input-bg)',
                fontSize: 11.5,
                fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                color: 'var(--t-text)',
                resize: 'vertical',
                outline: 'none',
                lineHeight: 1.45,
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onEditingFieldChange({ packetId: packet.id, field: 'summary' })}
            style={{ ...rowChromeStyle, alignItems: 'flex-start', minHeight: 32 }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={{ ...rowLabelStyle, paddingTop: 2 }}>summary</span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 11.5,
                color: packet.summary ? 'var(--t-text)' : 'var(--t-text-faint)',
                lineHeight: 1.45,
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
                overflow: 'hidden',
                letterSpacing: '-0.005em',
              } as React.CSSProperties}
            >
              {packet.summary || 'What should this packet accomplish?'}
            </span>
            {chevron}
          </button>
        )}
      </div>

      {/* Runtime row */}
      <div data-packet-row style={{ position: 'relative', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)' }}>
        <button
          type="button"
          onClick={() => onEditingFieldChange(isEditingRuntime ? null : { packetId: packet.id, field: 'runtime' })}
          style={rowChromeStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span style={rowLabelStyle}>runtime</span>
          <span style={{ ...rowValueStyle, color: orchestratorRuntimeTone(packet.runtime).color, fontWeight: 600 }}>
            {runtimeDisplay}
          </span>
          {chevron}
        </button>
        {isEditingRuntime ? (
          <div
            style={{
              position: 'absolute',
              top: 30,
              left: 8,
              right: 8,
              zIndex: 20,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              background: 'var(--t-panel-solid)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
              overflow: 'hidden',
            }}
          >
            {(['codex', 'claude-code'] as const).map((runtime) => (
              <button
                key={runtime}
                type="button"
                onClick={() => {
                  onPatch((current) => ({ ...current, runtime }));
                  onEditingFieldChange(null);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  paddingTop: 7,
                  paddingRight: 10,
                  paddingBottom: 7,
                  paddingLeft: 10,
                  borderWidth: 0,
                  background: packet.runtime === runtime ? 'var(--t-accent-soft)' : 'transparent',
                  color: 'var(--t-text)',
                  fontSize: 11.5,
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => { if (packet.runtime !== runtime) e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                onMouseLeave={(e) => { if (packet.runtime !== runtime) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: orchestratorRuntimeTone(runtime).color }} />
                {runtime === 'claude-code' ? 'Claude Code' : 'Codex'}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Repo row */}
      <div data-packet-row style={{ position: 'relative', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)' }}>
        <button
          type="button"
          onClick={() => onEditingFieldChange(isEditingRepo ? null : { packetId: packet.id, field: 'repo' })}
          style={rowChromeStyle}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        >
          <span style={rowLabelStyle}>repo</span>
          <span style={{ ...rowValueStyle, color: workspaceLabel ? 'var(--t-text)' : 'var(--t-text-faint)' }}>
            {workspaceLabel ?? 'No target'}
          </span>
          {chevron}
        </button>
        {isEditingRepo ? (
          <div
            style={{
              position: 'absolute',
              top: 30,
              left: 8,
              right: 8,
              zIndex: 20,
              maxHeight: 220,
              overflowY: 'auto',
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              background: 'var(--t-panel-solid)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            }}
          >
            <button
              type="button"
              onClick={() => {
                onPatch((current) => ({ ...current, workspaceTargetPath: null }));
                onEditingFieldChange(null);
              }}
              style={{
                display: 'block',
                width: '100%',
                paddingTop: 7,
                paddingRight: 10,
                paddingBottom: 7,
                paddingLeft: 10,
                borderWidth: 0,
                background: !packet.workspaceTargetPath ? 'var(--t-accent-soft)' : 'transparent',
                color: 'var(--t-text-faint)',
                fontSize: 11,
                fontStyle: 'italic',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              No target
            </button>
            {workspaceTargets.map((target) => {
              const isSelected = target.localPath === packet.workspaceTargetPath;
              return (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => {
                    onPatch((current) => ({
                      ...current,
                      workspaceTargetPath: target.localPath,
                      branchTarget: target.branch ?? current.branchTarget,
                    }));
                    onEditingFieldChange(null);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    paddingTop: 7,
                    paddingRight: 10,
                    paddingBottom: 7,
                    paddingLeft: 10,
                    borderWidth: 0,
                    background: isSelected ? 'var(--t-accent-soft)' : 'transparent',
                    color: 'var(--t-text)',
                    fontSize: 11.5,
                    fontWeight: 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                >
                  {target.label}
                </button>
              );
            })}
            {workspaceTargets.length === 0 ? (
              <div style={{ paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, fontSize: 11, color: 'var(--t-text-muted)' }}>
                No workspaces available
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Branch row */}
      <div data-packet-row>
        {isEditingBranch ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 5, paddingRight: 10, paddingBottom: 5, paddingLeft: 10 }}>
            <span style={rowLabelStyle}>branch</span>
            <input
              autoFocus
              value={packet.branchTarget}
              onChange={(event) => onPatch((current) => ({ ...current, branchTarget: event.target.value }))}
              onBlur={() => onEditingFieldChange(null)}
              onKeyDown={(event) => { if (event.key === 'Enter') onEditingFieldChange(null); }}
              placeholder="branch"
              style={{
                flex: 1,
                minWidth: 0,
                paddingTop: 4,
                paddingRight: 8,
                paddingBottom: 4,
                paddingLeft: 8,
                borderRadius: 6,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-accent-border)',
                background: 'var(--t-input-bg)',
                fontSize: 11.5,
                color: 'var(--t-text)',
                outline: 'none',
                fontFamily: 'inherit',
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onEditingFieldChange({ packetId: packet.id, field: 'branch' })}
            style={rowChromeStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={rowLabelStyle}>branch</span>
            <span style={{ ...rowValueStyle, color: packet.branchTarget ? 'var(--t-text)' : 'var(--t-text-faint)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}>
              {packet.branchTarget || 'main'}
            </span>
            {chevron}
          </button>
        )}
      </div>
    </>
  );
}
