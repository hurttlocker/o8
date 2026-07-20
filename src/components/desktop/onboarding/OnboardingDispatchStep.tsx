'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  PickerMenu,
  type DispatchRuntime,
} from '@/components/desktop/settings/dispatch-shared';
import {
  canSelectOnboardingRuntime,
  loadOnboardingRuntimeSelection,
  persistOnboardingRuntimeSelection,
  toggleOnboardingWorkerRuntime,
  type DispatchableRuntimeInventoryItem,
  type OnboardingOrchestratorRuntime,
} from './onboarding-runtime-selection';

const FONT = 'var(--font-sans-system)';

const ORCHESTRATOR_LABELS: Record<OnboardingOrchestratorRuntime, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
};

function CheckGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function RuntimeInventoryRow({
  runtime,
  selected,
  isDefault,
  onToggle,
}: {
  runtime: DispatchableRuntimeInventoryItem;
  selected: boolean;
  isDefault: boolean;
  onToggle: () => void;
}) {
  const selectable = runtime.available;
  return (
    <button
      type="button"
      disabled={!selectable}
      aria-pressed={selected}
      onClick={onToggle}
      style={{
        width: '100%',
        minHeight: 58,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        paddingTop: 9,
        paddingBottom: 9,
        paddingLeft: 12,
        paddingRight: 12,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: selected ? 'var(--t-accent)' : 'var(--t-glass-border-strong)',
        borderRadius: 10,
        background: selected ? 'var(--t-input-bg)' : 'var(--t-bg-card)',
        color: 'var(--t-text)',
        fontFamily: FONT,
        textAlign: 'left',
        cursor: selectable ? 'pointer' : 'not-allowed',
        opacity: selectable ? 1 : 0.52,
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
            {runtime.label}
          </span>
          {isDefault ? (
            <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-accent)' }}>
              Default worker
            </span>
          ) : null}
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 300, lineHeight: 1.35, color: 'var(--t-text-muted)' }}>
          {selectable ? runtime.detail : runtime.fix || runtime.detail}
        </span>
      </span>
      <span style={{
        width: 24,
        height: 24,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: selected ? 'var(--t-accent)' : 'var(--t-glass-border-strong)',
        background: selected ? 'var(--t-accent)' : 'transparent',
        color: selected ? 'var(--t-success-contrast)' : 'var(--t-text-faint)',
      }}>
        {selected ? <CheckGlyph /> : null}
      </span>
    </button>
  );
}

export const OnboardingDispatchStep = memo(function OnboardingDispatchStep({
  onContinue,
  onSkip,
  renderButton,
}: {
  onContinue: () => void;
  onSkip: () => void;
  renderButton: (props: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  }) => ReactNode;
}) {
  const [inventory, setInventory] = useState<DispatchableRuntimeInventoryItem[]>([]);
  const [orchestratorRuntime, setOrchestratorRuntime] = useState<OnboardingOrchestratorRuntime>('codex');
  const [workerRuntimes, setWorkerRuntimes] = useState<DispatchRuntime[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadOnboardingRuntimeSelection()
      .then((selection) => {
        if (!active) return;
        setInventory(selection.inventory);
        setOrchestratorRuntime(selection.orchestratorRuntime);
        setWorkerRuntimes(selection.workerRuntimes);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : 'Runtime inventory is unavailable.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const orchestratorOptions = useMemo(() => (
    (['codex', 'claude-code'] as const)
      .filter((runtime) => canSelectOnboardingRuntime(inventory, runtime))
      .map((runtime) => ({
        value: runtime,
        label: ORCHESTRATOR_LABELS[runtime],
        detail: inventory.find((item) => item.id === runtime)?.detail,
      }))
  ), [inventory]);

  const orchestratorAvailable = canSelectOnboardingRuntime(inventory, orchestratorRuntime);
  const readyToSave = orchestratorAvailable && workerRuntimes.length > 0;

  const handleContinue = useCallback(async () => {
    if (!readyToSave) return;
    setSaving(true);
    setError(null);
    try {
      await persistOnboardingRuntimeSelection({ orchestratorRuntime, workerRuntimes });
      onContinue();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save runtime choices.');
    } finally {
      setSaving(false);
    }
  }, [onContinue, orchestratorRuntime, readyToSave, workerRuntimes]);

  return (
    <div style={{
      maxWidth: 620,
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      fontFamily: FONT,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
          Choose the CLI that drives o8, then choose the runtimes that can receive packet work.
        </div>
        <div style={{ fontSize: 12, color: 'var(--t-text-faint)', lineHeight: 1.5 }}>
          Only installed and signed-in runtimes can be selected. Codex stays the default if you skip.
        </div>
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 14,
        minHeight: 54,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-glass-border-strong)',
        background: 'var(--t-bg-card)',
      }}>
        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>
            Orchestrator
          </span>
          <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--t-text-muted)' }}>
            Runs the planning and review loop.
          </span>
        </span>
        <PickerMenu<OnboardingOrchestratorRuntime>
          value={orchestratorRuntime}
          options={orchestratorOptions}
          onChange={setOrchestratorRuntime}
          disabled={loading || orchestratorOptions.length === 0}
          minWidth={190}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
            Worker runtimes
          </span>
          <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)' }}>
            Select one or more
          </span>
        </div>
        {loading ? (
          <div style={{ minHeight: 58, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 12 }}>
            Reading installed runtimes…
          </div>
        ) : inventory.length > 0 ? inventory.map((runtime) => (
          <RuntimeInventoryRow
            key={runtime.id}
            runtime={runtime}
            selected={workerRuntimes.includes(runtime.id)}
            isDefault={workerRuntimes[0] === runtime.id}
            onToggle={() => {
              setWorkerRuntimes((current) => toggleOnboardingWorkerRuntime(current, runtime.id, inventory));
            }}
          />
        )) : (
          <div style={{ minHeight: 58, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-text-muted)', fontSize: 12, textAlign: 'center' }}>
            No dispatchable runtimes were reported. Install or sign in to a supported CLI, then reopen setup.
          </div>
        )}
      </div>

      {error ? (
        <div role="alert" style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--t-brand-red)', textAlign: 'center' }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <button
          type="button"
          onClick={onSkip}
          style={{
            minHeight: 44,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-faint)',
            fontSize: 12,
            fontWeight: 300,
            cursor: 'pointer',
            fontFamily: FONT,
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 4,
            paddingRight: 4,
          }}
        >
          Skip for now
        </button>
        {renderButton({
          label: saving ? 'Saving…' : 'Save runtime choices',
          onClick: handleContinue,
          disabled: loading || saving || !readyToSave,
        })}
      </div>
    </div>
  );
});
