'use client';

/**
 * WorktreeRetentionSection — the Worktrees retention settings surface
 * (Cursor-parity wave 2, analog of Cursor's Workspaces page).
 *
 * Two operator knobs that bound how much `.cortex-worktrees` disk o8 keeps:
 * a max worktree COUNT and a max total SIZE (GB). Both write through the same
 * gated /api/panel/operator-defaults route as the Dispatch / Git & PRs tabs and
 * are enforced OLDEST-FIRST at the WorktreeManager prune seam — the guard only
 * ever removes terminal-lane / orphan worktrees with a clean git status, never
 * active work. A status row reads the live count + measured size across repos.
 *
 * Exported as a standalone section; the orchestrator mounts it (no nav wiring
 * here). Self-contained: it owns its own fetch/save and defines its own response
 * shape rather than coupling to the Dispatch tab's mirror type.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { APP_FONT_STACK, MONO_FONT_STACK, RAMS_CONTROL_ACTIVE_BG, RAMS_CONTROL_ACTIVE_BORDER, RAMS_CONTROL_BG, RAMS_CONTROL_BORDER, SETTINGS_CONTENT_MAX_WIDTH, TabHeading } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import { fetchOperatorDefaults } from './operator-defaults-client';

const ENV_LOCKED_REASON = 'Locked by an environment variable. Unset it to manage from Settings.';
const CONTROL_TARGET_PX = 44;
type RetentionField =
  | 'worktreeMaxCount'
  | 'worktreeMaxTotalGb'
  | 'storageReserveRatio'
  | 'storageReserveFloorGb'
  | 'workspaceParkingMode';
type SettingSource = 'env' | 'file' | 'default';
type WorkspaceParkingMode = 'manual' | 'pressure';
type BusyKey = RetentionField | `repo:${string}`;
type StorageAccountingStatus = 'observed' | 'partial' | 'unknown';
type StorageCategory = 'source' | 'dependency' | 'build' | 'runtime' | 'transcript';
type StorageMeasurementMethod =
  | 'workspace-residual'
  | 'known-path-sum'
  | 'owned-root-residual'
  | 'owned-session-artifact-sum';
interface DefaultsResponse {
  values: Record<string, unknown> & {
    worktreeMaxCount: number;
    worktreeMaxTotalGb: number;
    storageReserveRatio: number;
    storageReserveFloorGb: number;
    workspaceParkingMode: WorkspaceParkingMode;
  };
  sources: Record<string, SettingSource>;
}

interface CategoryUsage {
  category: StorageCategory;
  measurementMethod: StorageMeasurementMethod;
  accountingStatus: StorageAccountingStatus;
  allocatedBytes: number | null;
  logicalBytes: number | null;
}

interface UsageResponse {
  error?: string;
  accountingStatus: StorageAccountingStatus;
  totalCount: number | null;
  totalBytes: number | null;
  totalAllocatedBytes: number | null;
  totalLogicalBytes: number | null;
  totalGb: number | null;
  categoryStorage: {
    measuredAt: string;
    accountingStatus: StorageAccountingStatus;
    freshness: {
      source: 'measured' | 'cache' | 'coalesced';
      ageMs: number;
      ttlMs: number;
    };
    categories: Record<StorageCategory, CategoryUsage>;
  };
  storageAdmission: {
    accountingStatus: StorageAccountingStatus;
    physicalAvailableBytes: number | null;
    reservedBytes: number | null;
    dispatchHeadroomBytes: number | null;
    activeReservations: number;
  };
  storagePressure: {
    mode: WorkspaceParkingMode;
    automaticParkingEnabled: boolean;
    eligibleRepositories: number;
    optedOutRepositories: number;
    parkedWorkspaces: number;
    repositories: Array<{ id: string; name: string; parkingDisabled: boolean }>;
  };
  repos: Array<{
    name: string;
    path: string;
    count: number | null;
    bytes: number | null;
    allocatedBytes: number | null;
    logicalBytes: number | null;
  }>;
}

type UsageLoadState = 'loading' | 'ready' | 'error';

const STORAGE_CATEGORIES: Array<{ key: StorageCategory; label: string }> = [
  { key: 'source', label: 'Source files' },
  { key: 'dependency', label: 'Dependencies' },
  { key: 'build', label: 'Build output' },
  { key: 'runtime', label: 'Runtime state' },
  { key: 'transcript', label: 'Transcripts' },
];

// ── Icons ──

function StackIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function DiskIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}

function GaugeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 21a9 9 0 1 0-9-9" />
      <path d="M12 12l4-3" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

// ── Stepper ──

function Stepper({ value, onChange, step, min, max, unit, disabled }: {
  value: number;
  onChange: (next: number) => void;
  step: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
}) {
  const btn = (label: string, delta: number, ariaLabel: string) => {
    const next = Math.max(min, Math.min(max, value + delta));
    const atEdge = next === value;
    const off = disabled || atEdge;
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        disabled={off}
        onClick={() => { if (!off) onChange(next); }}
        style={{
          width: CONTROL_TARGET_PX,
          height: CONTROL_TARGET_PX,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: RAMS_CONTROL_BORDER,
          borderRadius: 8,
          background: RAMS_CONTROL_BG,
          color: 'var(--t-text)',
          fontSize: 16,
          fontFamily: APP_FONT_STACK,
          lineHeight: 1,
          cursor: off ? 'not-allowed' : 'pointer',
          opacity: off ? 0.4 : 1,
          transition: 'opacity 120ms ease',
        }}
      >
        {label}
      </button>
    );
  };

  const display = value <= 0 ? '∞' : `${value}${unit ? ` ${unit}` : ''}`;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      {btn('−', -step, 'Decrease')}
      <span style={{
        minWidth: 56,
        textAlign: 'center',
        fontFamily: MONO_FONT_STACK,
        fontSize: 12.5,
        color: 'var(--t-text)',
        letterSpacing: '-0.005em',
      }}>
        {display}
      </span>
      {btn('+', step, 'Increase')}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 GB';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function formatMeasuredAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unknown time';
  return new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function formatFreshness(freshness: UsageResponse['categoryStorage']['freshness']): string {
  const age = freshness.ageMs < 1_000
    ? 'now'
    : `${Math.round(freshness.ageMs / 1_000)}s ago`;
  if (freshness.source === 'cache') return `Cached ${age}`;
  if (freshness.source === 'coalesced') return `Shared measurement ${age}`;
  return `Measured ${age}`;
}

function formatMethod(method: StorageMeasurementMethod | undefined): string {
  if (!method) return 'Method unknown';
  return `Method: ${method.replaceAll('-', ' ')}`;
}

function UsageMetric({ label, value, error }: {
  label: string;
  value: string;
  error: boolean;
}) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 9.5,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        color: 'var(--t-text-faint)',
      }}>
        {label}
      </span>
      <ValuePill tone={error ? 'destructive' : 'default'}>{value}</ValuePill>
    </span>
  );
}

function ParkingModeControl({
  value,
  disabled,
  onChange,
}: {
  value: WorkspaceParkingMode;
  disabled: boolean;
  onChange: (value: WorkspaceParkingMode) => void;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {(['manual', 'pressure'] as const).map((mode) => {
        const selected = value === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-label={`Set workspace parking to ${mode}`}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => { if (!selected) onChange(mode); }}
            style={{
              minWidth: 88,
              height: CONTROL_TARGET_PX,
              paddingLeft: 14,
              paddingRight: 14,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: selected ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
              borderRadius: 8,
              backgroundColor: selected ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
              color: selected ? 'var(--t-text)' : 'var(--t-text-secondary)',
              fontFamily: APP_FONT_STACK,
              fontSize: 12,
              fontWeight: 300,
              cursor: disabled || selected ? 'default' : 'pointer',
              opacity: disabled ? 0.45 : 1,
              transitionProperty: 'background-color, border-color, opacity',
              transitionDuration: '140ms, 140ms, 120ms',
              transitionTimingFunction: 'ease, ease, ease',
            }}
          >
            {mode === 'manual' ? 'Manual' : 'Pressure'}
          </button>
        );
      })}
    </span>
  );
}

function hasUsageShape(value: unknown): value is UsageResponse {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<UsageResponse>;
  const byteValue = (candidate: unknown) => candidate === null || typeof candidate === 'number';
  const categories = payload.categoryStorage?.categories;
  return (
    (payload.accountingStatus === 'observed'
      || payload.accountingStatus === 'partial'
      || payload.accountingStatus === 'unknown')
    && byteValue(payload.totalCount)
    && byteValue(payload.totalAllocatedBytes)
    && byteValue(payload.totalLogicalBytes)
    && Array.isArray(payload.repos)
    && !!payload.storageAdmission
    && !!payload.storagePressure
    && Array.isArray(payload.storagePressure.repositories)
    && !!payload.categoryStorage
    && !!categories
    && STORAGE_CATEGORIES.every(({ key }) => !!categories[key])
  );
}

export function WorktreeRetentionSection() {
  const [data, setData] = useState<DefaultsResponse | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usageState, setUsageState] = useState<UsageLoadState>('loading');
  const [usageError, setUsageError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<BusyKey | null>(null);
  const [repoParkingStage, setRepoParkingStage] = useState<'saving' | 'refreshing' | null>(null);
  const busyKeyRef = useRef<BusyKey | null>(null);
  const usageRequestRef = useRef(0);

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaults();
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load worktree settings.');
      }
      setData(payload as DefaultsResponse);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load worktree settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUsage = useCallback(async (preserveCurrent = false) => {
    const requestId = usageRequestRef.current + 1;
    usageRequestRef.current = requestId;
    if (!preserveCurrent) setUsage(null);
    setUsageState('loading');
    setUsageError(null);
    try {
      const response = await fetch('/api/worktrees/retention-usage', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as Partial<UsageResponse> & {
        error?: unknown;
      };
      if (usageRequestRef.current !== requestId) return;
      if (!hasUsageShape(payload)) {
        throw new Error(
          typeof payload.error === 'string'
            ? payload.error
            : 'Storage measurement returned incomplete accounting.',
        );
      }
      setUsage(payload);
      if (!response.ok || payload.accountingStatus !== 'observed') {
        setUsageState('error');
        setUsageError(
          typeof payload.error === 'string'
            ? payload.error
            : 'Storage measurement contains unknown accounting.',
        );
        return;
      }
      setUsageState('ready');
    } catch (error) {
      if (usageRequestRef.current !== requestId) return;
      setUsage(null);
      setUsageState('error');
      setUsageError(error instanceof Error ? error.message : 'Storage measurement is unavailable.');
    }
  }, []);

  useEffect(() => {
    void loadDefaults();
    void loadUsage();
    return () => { usageRequestRef.current += 1; };
  }, [loadDefaults, loadUsage]);

  const updateField = useCallback((field: RetentionField, value: number | WorkspaceParkingMode) => {
    if (busyKeyRef.current) return;
    busyKeyRef.current = field;
    void (async () => {
      setBusyKey(field);
      setNotice(null);
      try {
        const response = await fetchOperatorDefaults({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: value }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to update setting.');
        }
        setData(payload as DefaultsResponse);
        if (field === 'workspaceParkingMode') void loadUsage();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Failed to update setting.');
      } finally {
        busyKeyRef.current = null;
        setBusyKey(null);
      }
    })();
  }, [loadUsage]);

  const updateRepoParking = useCallback((repoId: string, parkingDisabled: boolean) => {
    const key = `repo:${repoId}` as const;
    if (busyKeyRef.current) return;
    busyKeyRef.current = key;
    setBusyKey(key);
    setRepoParkingStage('saving');
    setNotice(null);
    void fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', id: repoId, storagePressureParkingDisabled: parkingDisabled }),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to update repository parking.');
      setRepoParkingStage('refreshing');
      await loadUsage(true);
    }).catch((error) => {
      setNotice(error instanceof Error ? error.message : 'Failed to update repository parking.');
    }).finally(() => {
      busyKeyRef.current = null;
      setBusyKey(null);
      setRepoParkingStage(null);
    });
  }, [loadUsage]);

  if (loading && !data) {
    return (
      <div style={{ paddingTop: 40, color: 'var(--t-text-muted)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        Loading worktree settings...
      </div>
    );
  }

  const values = data?.values;
  const sources = data?.sources;

  if (!values || !sources) {
    return (
      <div style={{ paddingTop: 40, color: 'var(--t-brand-red, #b91c1c)', fontSize: 13, fontFamily: APP_FONT_STACK }}>
        {notice ?? 'Unable to load worktree settings.'}
      </div>
    );
  }

  const envLocked = (field: RetentionField) => sources[field] === 'env';
  const lockedSub = (field: RetentionField, normal: string) => (envLocked(field) ? ENV_LOCKED_REASON : normal);
  const usageSubtitle = usageState === 'loading'
    ? 'Measuring allocated and logical worktree storage…'
    : usageState === 'error'
      ? `Measurement incomplete: ${usageError ?? 'Unknown storage measurement error.'}`
      : usage?.totalCount === null
        ? `Worktree count unknown across ${usage?.repos.length ?? 0} measured repositories`
        : `${usage!.totalCount} worktree${usage!.totalCount === 1 ? '' : 's'} across ${usage!.repos.length} repo${usage!.repos.length === 1 ? '' : 's'}`;
  const allocatedUsage = usageState === 'loading'
    ? '—'
    : usage?.totalAllocatedBytes === null || usage?.totalAllocatedBytes === undefined
      ? 'Unknown'
      : formatBytes(usage.totalAllocatedBytes);
  const logicalUsage = usageState === 'loading'
    ? '—'
    : usage?.totalLogicalBytes === null || usage?.totalLogicalBytes === undefined
      ? 'Unknown'
      : formatBytes(usage.totalLogicalBytes);
  const admission = usageState === 'loading' ? null : usage?.storageAdmission;
  const admissionUnknown = !admission || admission.accountingStatus !== 'observed';
  const admissionMetric = (value: number | null | undefined) => (
    value === null || value === undefined ? 'Unknown' : formatBytes(value)
  );
  const pressure = usageState === 'loading' && repoParkingStage === null ? null : usage?.storagePressure;
  const categoryStorage = usageState === 'loading' ? null : usage?.categoryStorage;
  const categoryMetric = (category: CategoryUsage | undefined, metric: 'allocatedBytes' | 'logicalBytes') => (
    usageState === 'loading'
      ? '—'
      : !category || category[metric] === null
        ? 'Unknown'
        : formatBytes(category[metric])
  );
  const categoryFootnote = categoryStorage
    ? `${formatFreshness(categoryStorage.freshness)}. Snapshot ${formatMeasuredAt(categoryStorage.measuredAt)}. Allocated and logical bytes are observational. APFS clones and shared blocks mean categories are neither exclusive nor guaranteed reclaimable.`
    : usageState === 'loading'
      ? 'Reading category measurements. Allocated and logical bytes are observational, not exclusive or guaranteed reclaimable.'
      : 'Category accounting is unavailable. Unknown values are never converted to zero.';

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="worktrees"
        subtitle="How much disk o8 keeps for the isolated worktrees it spins up per packet. When a repo exceeds either limit, the oldest safe worktrees are reclaimed first — never one with unmerged work or an active agent."
      />

      {notice ? (
        <div style={{ marginBottom: 28, fontSize: 13, color: 'var(--t-text)', lineHeight: 1.55 }}>
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#ef4444',
            marginRight: 8,
          }}>
            [error]
          </span>
          {notice}
        </div>
      ) : null}

      <section>
        <SettingsGroup
          header="Retention"
          footnote="Limits are enforced during o8's periodic worktree sweep, oldest-first. A worktree is only ever removed when it backs no active or reviewing agent AND has a clean git status — a dirty tree is always skipped, and unmerged commits are preserved as a branch before its directory is reclaimed. Set a limit to 0 for unbounded (∞)."
        >
          <SettingsRow
            icon={<StackIcon />}
            label="Max worktrees"
            subtitle={lockedSub('worktreeMaxCount', 'Most packet worktrees kept per repo before the oldest safe ones are pruned')}
            accessory={
              <Stepper
                value={values.worktreeMaxCount}
                onChange={(next) => { updateField('worktreeMaxCount', next); }}
                step={1}
                min={0}
                max={200}
                disabled={envLocked('worktreeMaxCount') || busyKey !== null}
              />
            }
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="Max total size"
            subtitle={lockedSub('worktreeMaxTotalGb', 'Total on-disk size of packet worktrees per repo before the oldest safe ones are pruned')}
            accessory={
              <Stepper
                value={values.worktreeMaxTotalGb}
                onChange={(next) => { updateField('worktreeMaxTotalGb', next); }}
                step={5}
                min={0}
                max={500}
                unit="GB"
                disabled={envLocked('worktreeMaxTotalGb') || busyKey !== null}
              />
            }
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Workspace parking"
          footnote="Manual mode parks workspaces only when the operator asks. Pressure mode may park the oldest eligible reviewing workspace after a dispatch is held for low space, then retries admission. Parking removes only a verified rebuildable checkout while preserving its Git and review receipt for exact restoration. Repositories can opt out individually."
        >
          <SettingsRow
            icon={<StackIcon />}
            label="Parking mode"
            subtitle={lockedSub(
              'workspaceParkingMode',
              values.workspaceParkingMode === 'pressure'
                ? 'Pressure parking is enabled for eligible repositories'
                : 'Workspaces park only when the operator asks',
            )}
            accessory={
              <ParkingModeControl
                value={values.workspaceParkingMode}
                disabled={envLocked('workspaceParkingMode') || busyKey !== null}
                onChange={(next) => { updateField('workspaceParkingMode', next); }}
              />
            }
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="Fleet parking"
            subtitle={pressure
              ? pressure.automaticParkingEnabled
                ? 'Automatic parking is active when dispatch reserve is breached.'
                : 'Automatic parking is off. Manual parking remains available from packet review.'
              : usageState === 'loading'
                ? 'Reading the fleet parking projection…'
                : 'Fleet parking projection is unavailable.'}
            accessory={
              <span aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <UsageMetric label="Parked" value={pressure ? String(pressure.parkedWorkspaces) : usageState === 'loading' ? '—' : 'Unknown'} error={!pressure && usageState !== 'loading'} />
                <UsageMetric label="Eligible repos" value={pressure ? String(pressure.eligibleRepositories) : usageState === 'loading' ? '—' : 'Unknown'} error={!pressure && usageState !== 'loading'} />
                <UsageMetric label="Opted out" value={pressure ? String(pressure.optedOutRepositories) : usageState === 'loading' ? '—' : 'Unknown'} error={!pressure && usageState !== 'loading'} />
              </span>
            }
            divider={Boolean(pressure?.repositories.length)}
          />
          {pressure?.repositories.map((repo, index) => (
            <SettingsRow
              key={repo.id}
              icon={<StackIcon />}
              label={repo.name}
              subtitle={repo.parkingDisabled
                ? 'Automatic pressure parking is disabled for this repository.'
                : 'Eligible reviewing workspaces may park when the reserve is breached.'}
              accessory={
                <button
                  type="button"
                  aria-label={`${repo.parkingDisabled ? 'Allow' : 'Disable'} pressure parking for ${repo.name}`}
                  aria-pressed={repo.parkingDisabled}
                  disabled={busyKey !== null}
                  onClick={() => { updateRepoParking(repo.id, !repo.parkingDisabled); }}
                  style={{
                    minWidth: 120,
                    height: CONTROL_TARGET_PX,
                    paddingLeft: 12,
                    paddingRight: 12,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: repo.parkingDisabled ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
                    borderRadius: 8,
                    backgroundColor: repo.parkingDisabled ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
                    color: 'var(--t-text-secondary)',
                    fontFamily: APP_FONT_STACK,
                    fontSize: 11,
                    cursor: busyKey !== null ? 'wait' : 'pointer',
                    opacity: busyKey !== null ? 0.55 : 1,
                  }}
                >
                  {busyKey === `repo:${repo.id}`
                    ? repoParkingStage === 'refreshing' ? 'Refreshing usage' : 'Saving policy'
                    : repo.parkingDisabled ? 'Opted out' : 'Allowed'}
                </button>
              }
              divider={index < pressure.repositories.length - 1}
            />
          ))}
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Dispatch reserve"
          footnote="Before o8 creates a packet workspace, it reserves the estimated growth and keeps the larger of these two free-space limits. A reservation is accounting only; it is not physical disk usage. Unknown accounting holds dispatch and does not delete anything."
        >
          <SettingsRow
            icon={<GaugeIcon />}
            label="Volume reserve"
            subtitle={lockedSub('storageReserveRatio', 'Share of total volume capacity that must remain available')}
            accessory={
              <Stepper
                value={Math.round(values.storageReserveRatio * 100)}
                onChange={(next) => { updateField('storageReserveRatio', next / 100); }}
                step={1}
                min={1}
                max={50}
                unit="%"
                disabled={envLocked('storageReserveRatio') || busyKey !== null}
              />
            }
            divider
          />
          <SettingsRow
            icon={<DiskIcon />}
            label="Absolute floor"
            subtitle={lockedSub('storageReserveFloorGb', 'Minimum physical space that must remain available after reservations')}
            accessory={
              <Stepper
                value={values.storageReserveFloorGb}
                onChange={(next) => { updateField('storageReserveFloorGb', next); }}
                step={1}
                min={1}
                max={500}
                unit="GB"
                disabled={envLocked('storageReserveFloorGb') || busyKey !== null}
              />
            }
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Worktree storage"
          footnote="On disk is allocated filesystem space and preserves the existing retention metric. Logical is apparent file size. APFS clones and shared blocks mean neither number is exclusive or guaranteed reclaimable; actual host-space change is measured separately when a workspace is parked or restored."
        >
          <SettingsRow
            icon={<DiskIcon />}
            label="Current usage"
            subtitle={usageSubtitle}
            accessory={
              <span aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <UsageMetric label="On disk" value={allocatedUsage} error={allocatedUsage === 'Unknown'} />
                <UsageMetric label="Logical" value={logicalUsage} error={logicalUsage === 'Unknown'} />
                <button
                  type="button"
                  aria-label="Refresh usage"
                  disabled={usageState === 'loading'}
                  onClick={() => { void loadUsage(); }}
                  style={{
                    minWidth: CONTROL_TARGET_PX,
                    height: CONTROL_TARGET_PX,
                    paddingLeft: 12,
                    paddingRight: 12,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: RAMS_CONTROL_BORDER,
                    borderRadius: 8,
                    background: RAMS_CONTROL_BG,
                    color: 'var(--t-text-secondary)',
                    fontSize: 12,
                    fontFamily: APP_FONT_STACK,
                    cursor: usageState === 'loading' ? 'wait' : 'pointer',
                    opacity: usageState === 'loading' ? 0.55 : 1,
                  }}
                >
                  Refresh
                </button>
              </span>
            }
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="Dispatch headroom"
            subtitle={admissionUnknown
              ? 'Admission accounting is unknown; new packet workspaces will be held.'
              : `${admission.activeReservations} active reservation${admission.activeReservations === 1 ? '' : 's'}. Reserved estimates are separate from physical usage.`}
            accessory={
              <span aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <UsageMetric label="Physical available" value={admissionMetric(admission?.physicalAvailableBytes)} error={admissionMetric(admission?.physicalAvailableBytes) === 'Unknown'} />
                <UsageMetric label="Reserved estimate" value={admissionMetric(admission?.reservedBytes)} error={admissionMetric(admission?.reservedBytes) === 'Unknown'} />
                <UsageMetric label="Dispatch headroom" value={admissionMetric(admission?.dispatchHeadroomBytes)} error={admissionMetric(admission?.dispatchHeadroomBytes) === 'Unknown'} />
              </span>
            }
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Storage categories"
          footnote={categoryFootnote}
        >
          {STORAGE_CATEGORIES.map(({ key, label }, index) => {
            const category = categoryStorage?.categories[key];
            const allocated = categoryMetric(category, 'allocatedBytes');
            const logical = categoryMetric(category, 'logicalBytes');
            return (
              <SettingsRow
                key={key}
                icon={<DiskIcon />}
                label={label}
                subtitle={usageState === 'loading' ? 'Measuring category storage…' : formatMethod(category?.measurementMethod)}
                accessory={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <UsageMetric label="Allocated" value={allocated} error={allocated === 'Unknown'} />
                    <UsageMetric label="Logical" value={logical} error={logical === 'Unknown'} />
                  </span>
                }
                divider={index < STORAGE_CATEGORIES.length - 1}
              />
            );
          })}
        </SettingsGroup>
      </section>
    </div>
  );
}
