'use client';

import { useEffect, useState } from 'react';
import { BranchPickerPopover } from '@/components/desktop/thoughts/BranchPickerPopover';
import { orchestratorRuntimeTone, packetRuntimeModelDisplayLabel } from '@/lib/orchestrator/display';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorPacket, OrchestratorRuntime, OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import {
  clearPacketBranchBlockedReason,
  hasPacketBranchTarget,
} from '@/components/desktop/thoughts/mission-panel/branchTarget';
import { fetchThoughtsOperatorDefaults } from '@/components/desktop/thoughts/operator-defaults';
import type { EditingField } from './types';

// Client-side cache for the experimentalOpencode flag. Populated once per
// component lifetime; refreshed when the Settings toggle fires (the POST
// endpoint revalidates on its own). Avoids prop-drilling the flag through
// every mission-panel layer for a single opt-in toggle.
let cachedExperimentalOpencode: boolean | null = null;
let cachedExperimentalGemini: boolean | null = null;

// #747 — Routing recommendation cache. One entry per repoPath; refreshed
// lazily so the chip stays consistent across packet cards on the same repo.
interface RuntimeEvidenceRow {
  runtime: OrchestratorRuntime;
  score: number;
  total: number;
  mergedClean: number;
}
interface RuntimeRecommendationPayload {
  runtime: OrchestratorRuntime | null;
  score: number;
  evidence: Partial<Record<OrchestratorRuntime, RuntimeEvidenceRow>>;
}
const recommendationCache = new Map<string, { value: RuntimeRecommendationPayload | null; expiresAt: number }>();
// #861 — TTL dropped from 30s → 10s so the chip reflects fresh outcomes shortly
// after a packet completes. The route is cheap aggregation and the cache is
// per-repoPath, so the extra fetch cost is negligible. Cross-card invalidation
// via a shared event would be cleaner but adds plumbing for marginal gain.
const RECOMMENDATION_TTL_MS = 10_000;

// Phase 4 (#747 follow-up) — In-flight fetch dedupe. When a packet transitions
// draft → running, its PacketCard unmounts in the BACKLOG group and remounts
// in the IN PROGRESS group; if the original fetch was still in flight the
// previous mount's `controller.abort()` cancelled it, leaving the new mount
// to fire a fresh request. Under heavy WS load this can repeat enough that
// the chip never settles. Sharing a single Promise per repoPath fixes that
// without touching the per-mount cleanup contract.
const inFlightByRepo = new Map<string, Promise<RuntimeRecommendationPayload | null>>();

export function dependencyMaterializationLabel(mode: 'native' | 'image' | null | undefined): string | null {
  if (mode === 'image') return 'Shared APFS image';
  if (mode === 'native') return 'Native install';
  return null;
}

function fetchRecommendationFor(repoPath: string): Promise<RuntimeRecommendationPayload | null> {
  const existing = inFlightByRepo.get(repoPath);
  if (existing) return existing;
  const url = `/api/cortex/runtime-recommendation?repoPath=${encodeURIComponent(repoPath)}`;
  // Fetch detached from any AbortController — we never want a card unmount
  // to kill the request, since the cache it populates is shared across all
  // cards on the same repo.
  const promise = fetch(url)
    .then(async (response) => {
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      if (!data || data.ok !== true || !data.recommendation) return null;
      return data.recommendation as RuntimeRecommendationPayload;
    })
    .then((value) => {
      recommendationCache.set(repoPath, { value, expiresAt: Date.now() + RECOMMENDATION_TTL_MS });
      return value;
    })
    .catch(() => null)
    .finally(() => {
      inFlightByRepo.delete(repoPath);
    });
  inFlightByRepo.set(repoPath, promise);
  return promise;
}

function useRuntimeRecommendation(repoPath: string | null | undefined): RuntimeRecommendationPayload | null {
  const [payload, setPayload] = useState<RuntimeRecommendationPayload | null>(() => {
    if (!repoPath) return null;
    const cached = recommendationCache.get(repoPath);
    return cached && cached.expiresAt > Date.now() ? cached.value : null;
  });
  useEffect(() => {
    if (!repoPath) { setPayload(null); return; }
    const cached = recommendationCache.get(repoPath);
    if (cached && cached.expiresAt > Date.now()) {
      setPayload(cached.value);
      return;
    }
    let cancelled = false;
    fetchRecommendationFor(repoPath).then((value) => {
      if (!cancelled) setPayload(value);
    });
    return () => { cancelled = true; };
  }, [repoPath]);
  return payload;
}
function useExperimentalOpencodeFlag(override?: boolean): boolean {
  const [flag, setFlag] = useState<boolean>(
    override !== undefined ? override : (cachedExperimentalOpencode ?? false),
  );
  useEffect(() => {
    if (override !== undefined) { setFlag(override); return; }
    if (cachedExperimentalOpencode !== null) { setFlag(cachedExperimentalOpencode); return; }
    let cancelled = false;
    const controller = new AbortController();
    void fetchThoughtsOperatorDefaults(controller.signal).then((defaults) => {
      if (cancelled) return;
      cachedExperimentalOpencode = defaults.experimentalOpencode;
      setFlag(defaults.experimentalOpencode);
    });
    return () => { cancelled = true; controller.abort(); };
  }, [override]);
  return flag;
}

function useExperimentalGeminiFlag(override?: boolean): boolean {
  const [flag, setFlag] = useState<boolean>(
    override !== undefined ? override : (cachedExperimentalGemini ?? false),
  );
  useEffect(() => {
    if (override !== undefined) { setFlag(override); return; }
    if (cachedExperimentalGemini !== null) { setFlag(cachedExperimentalGemini); return; }
    let cancelled = false;
    const controller = new AbortController();
    void fetchThoughtsOperatorDefaults(controller.signal).then((defaults) => {
      if (cancelled) return;
      cachedExperimentalGemini = defaults.experimentalGemini;
      setFlag(defaults.experimentalGemini);
    });
    return () => { cancelled = true; controller.abort(); };
  }, [override]);
  return flag;
}

interface PacketMetaRowsProps {
  packet: OrchestratorPacket;
  workspaceTargets: OrchestratorWorkspaceTarget[];
  editingField: EditingField;
  onEditingFieldChange: (next: EditingField) => void;
  onPatch: (updater: (packet: OrchestratorPacket) => OrchestratorPacket) => void;
  /** When false (v1 default), opencode is hidden from the runtime picker. */
  experimentalOpencode?: boolean;
  /** When false (v1 default), Gemini is hidden from the runtime picker. */
  experimentalGemini?: boolean;
}

export function PacketMetaRows({
  packet,
  workspaceTargets,
  editingField,
  onEditingFieldChange,
  onPatch,
  experimentalOpencode,
  experimentalGemini,
}: PacketMetaRowsProps) {
  const opencodeEnabled = useExperimentalOpencodeFlag(experimentalOpencode);
  const geminiEnabled = useExperimentalGeminiFlag(experimentalGemini);
  const isEditingSummary = editingField?.packetId === packet.id && editingField.field === 'summary';
  const isEditingRuntime = editingField?.packetId === packet.id && editingField.field === 'runtime';
  const isEditingRepo = editingField?.packetId === packet.id && editingField.field === 'repo';
  const isEditingBranch = editingField?.packetId === packet.id && editingField.field === 'branch';
  const canEditBranch = packet.queueState === 'draft';
  // #747 — Routing recommendation chip. Only renders when the recommender has
  // a confident pick (`runtime` non-null) and the operator hasn't already
  // selected it. Per-runtime evidence rendered inside the popover.
  const recommendation = useRuntimeRecommendation(packet.workspaceTargetPath);
  const recommendedRuntime = recommendation?.runtime ?? null;
  const recommendationScorePct = recommendation && recommendedRuntime
    ? Math.round(recommendation.score * 100)
    : null;
  const showRecommendationChipOnRow = Boolean(
    recommendedRuntime && recommendedRuntime !== packet.runtime,
  );

  const workspaceLabel = packet.workspaceTargetPath
    ? (workspaceTargets.find((t) => t.localPath === packet.workspaceTargetPath)?.label ?? packet.workspaceTargetPath.split('/').pop() ?? 'target')
    : null;

  const runtimeDisplay = packetRuntimeModelDisplayLabel(packet);
  const resolvedWorkerModel = packet.workerRouting?.selectedModel ?? packet.assignedModel ?? null;
  const resolvedWorkerEffort = packet.workerRouting?.selectedEffort ?? null;
  const resolvedWorkerLabel = [resolvedWorkerModel, resolvedWorkerEffort]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
  const materializationLabel = dependencyMaterializationLabel(
    packet.lane?.dependencyMaterializationMode,
  );

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
    transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
  const rowLabelStyle: React.CSSProperties = {
    fontSize: 9,
    fontWeight: 300,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
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
                fontFamily: 'var(--font-sans-system)',
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

      {materializationLabel ? (
        <div
          data-packet-row
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minHeight: 28,
            paddingTop: 5,
            paddingRight: 10,
            paddingBottom: 5,
            paddingLeft: 10,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
          }}
        >
          <span style={rowLabelStyle}>dependencies</span>
          <span style={rowValueStyle}>{materializationLabel}</span>
        </div>
      ) : null}

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
          <span style={{ ...rowValueStyle, color: orchestratorRuntimeTone(packet.runtime).color, fontWeight: 400, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' as const }}>
            {/* min-width:0 lets the runtime label shrink so the recommendation
                chip never gets clipped by the row's overflow:hidden, even when
                running packets carry longer lane metadata or denser layout. */}
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{runtimeDisplay}</span>
            {showRecommendationChipOnRow && recommendedRuntime && recommendationScorePct !== null ? (
              <span
                title={`History on this repo prefers ${orchestratorRuntimeTone(recommendedRuntime).label} (${recommendationScorePct}% clean merge rate). Click to switch.`}
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: orchestratorRuntimeTone(recommendedRuntime).color,
                  background: 'var(--t-accent-soft)',
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-accent-border)',
                  borderRadius: 4,
                  paddingTop: 1,
                  paddingRight: 5,
                  paddingBottom: 1,
                  paddingLeft: 5,
                  flexShrink: 0,
                }}
              >
                {orchestratorRuntimeTone(recommendedRuntime).label} {recommendationScorePct}%
              </span>
            ) : null}
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
            {(() => {
              // #860 — When a hidden runtime (opencode / gemini) is excluded by
              // its experimental flag we still render its evidence row (disabled)
              // so operators can see historical data and understand WHY the
              // runtime was excluded.
              const experimental: OrchestratorRuntime[] = [];
              if (opencodeEnabled) experimental.push('opencode');
              if (geminiEnabled) experimental.push('gemini');
              if (packet.runtime === 'opencode' || packet.runtime === 'gemini') experimental.push(packet.runtime);
              const dispatchable = listDispatchableRuntimes({ experimental });
              const disabledRows = (['opencode', 'gemini'] as OrchestratorRuntime[])
                .filter((rt) => !dispatchable.includes(rt) && (recommendation?.evidence?.[rt]?.total ?? 0) > 0)
                .map((rt) => ({ runtime: rt, disabled: true }));
              const visibleRuntimes: Array<{ runtime: OrchestratorRuntime; disabled: boolean }> = [
                ...dispatchable.map((runtime) => ({ runtime, disabled: false })),
                ...disabledRows,
              ];
              return visibleRuntimes.map(({ runtime, disabled }) => {
                const evidence = recommendation?.evidence?.[runtime] ?? null;
                const isRecommended = !disabled && recommendedRuntime === runtime;
                const evidencePct = evidence && evidence.total > 0
                  ? Math.round((evidence.mergedClean / evidence.total) * 100)
                  : null;
                return (
                  <button
                    key={runtime}
                    type="button"
                    disabled={disabled}
                    title={disabled ? `${orchestratorRuntimeTone(runtime).label} is hidden in v1. Enable it in Settings → Operator Defaults to dispatch.` : undefined}
                    onClick={disabled ? undefined : () => {
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
                      color: disabled ? 'var(--t-text-muted)' : 'var(--t-text)',
                      fontSize: 11.5,
                      fontWeight: 500,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      textAlign: 'left',
                      opacity: disabled ? 0.65 : 1,
                    }}
                    onMouseEnter={(e) => { if (!disabled && packet.runtime !== runtime) e.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                    onMouseLeave={(e) => { if (!disabled && packet.runtime !== runtime) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: orchestratorRuntimeTone(runtime).color, flexShrink: 0, opacity: disabled ? 0.5 : 1 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                      {orchestratorRuntimeTone(runtime).label}
                    </span>
                    {disabled ? (
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: 'var(--t-text-muted)',
                          background: 'var(--t-divider-subtle)',
                          borderWidth: 1,
                          borderStyle: 'solid',
                          borderColor: 'var(--t-divider-subtle)',
                          borderRadius: 4,
                          paddingTop: 1,
                          paddingRight: 5,
                          paddingBottom: 1,
                          paddingLeft: 5,
                          flexShrink: 0,
                        }}
                      >
                        DISABLED
                      </span>
                    ) : null}
                    {isRecommended && evidencePct !== null ? (
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                          color: orchestratorRuntimeTone(runtime).color,
                          background: 'var(--t-accent-soft)',
                          borderWidth: 1,
                          borderStyle: 'solid',
                          borderColor: 'var(--t-accent-border)',
                          borderRadius: 4,
                          paddingTop: 1,
                          paddingRight: 5,
                          paddingBottom: 1,
                          paddingLeft: 5,
                          flexShrink: 0,
                        }}
                      >
                        RECOMMENDED · {evidencePct}%
                      </span>
                    ) : evidence && evidence.total > 0 ? (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 600,
                          color: 'var(--t-text-muted)',
                          flexShrink: 0,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {evidence.mergedClean}/{evidence.total}
                      </span>
                    ) : null}
                  </button>
                );
              });
            })()}
          </div>
        ) : null}
      </div>

      {resolvedWorkerLabel ? (
        <div
          data-packet-row
          title={`Resolved worker launch: ${resolvedWorkerLabel}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minHeight: 28,
            paddingTop: 5,
            paddingRight: 10,
            paddingBottom: 5,
            paddingLeft: 10,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: 'var(--t-divider-subtle)',
          }}
        >
          <span style={rowLabelStyle}>worker</span>
          <span style={rowValueStyle}>{resolvedWorkerLabel}</span>
        </div>
      ) : null}

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
                onPatch((current) => ({
                  ...current,
                  workspaceTargetPath: null,
                  branchTarget: '',
                  blockedReason: clearPacketBranchBlockedReason(current.blockedReason),
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
                      branchTarget: '',
                      blockedReason: clearPacketBranchBlockedReason(current.blockedReason),
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
      <div data-packet-row style={{ position: 'relative' }}>
        {canEditBranch ? (
          <button
            type="button"
            onClick={() => onEditingFieldChange(isEditingBranch ? null : { packetId: packet.id, field: 'branch' })}
            style={rowChromeStyle}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-divider-subtle)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={rowLabelStyle}>branch</span>
            <span style={{ ...rowValueStyle, color: hasPacketBranchTarget(packet.branchTarget) ? 'var(--t-text)' : 'var(--t-text-faint)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}>
              {hasPacketBranchTarget(packet.branchTarget) ? packet.branchTarget : 'Select branch'}
            </span>
            {chevron}
          </button>
        ) : (
          <div style={{ ...rowChromeStyle, cursor: 'default' }}>
            <span style={rowLabelStyle}>branch</span>
            <span style={{ ...rowValueStyle, color: hasPacketBranchTarget(packet.branchTarget) ? 'var(--t-text)' : 'var(--t-text-faint)', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}>
              {hasPacketBranchTarget(packet.branchTarget) ? packet.branchTarget : 'Not set'}
            </span>
          </div>
        )}
        {isEditingBranch && canEditBranch ? (
          <BranchPickerPopover
            open={isEditingBranch}
            workspaceTargetPath={packet.workspaceTargetPath}
            selectedBranch={packet.branchTarget}
            onSelect={(branchName) => {
              onPatch((current) => ({
                ...current,
                branchTarget: branchName,
                blockedReason: clearPacketBranchBlockedReason(current.blockedReason),
              }));
            }}
            onClose={() => onEditingFieldChange(null)}
          />
        ) : null}
      </div>
    </>
  );
}
