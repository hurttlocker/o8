'use client';

import type { ReactNode, Ref } from 'react';
import type { WorkerStartMode } from '@/lib/operator/worker-start-mode';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ComposerModelGroup } from '../ModelThinkingChip';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { ComposerPicker } from './ComposerPicker';
import { ModeChip } from './ModeChip';
import type {
  ComposerSelectorMode,
  ResolvedComposerSelectorState,
} from './state';
import { useComposerSelectorState } from './useComposerSelectorState';
import type { ComposerWorkerDefaults } from './worker-settings';

export function ComposerSelectorFooterView({
  state,
  defaults,
  composerModelGroups,
  onModeChange,
  onModelChange,
  onBackendChange,
  onEffortChange,
  onRuntimeChange,
  onWorkerModelChange,
  onWorkerStartModeChange,
  saving = false,
  leadingControls,
  attachControl,
  meterControl,
  micControl,
  voiceControl,
  sendControl,
  containerRef,
  onRequestTextareaFocus,
}: {
  input: string;
  state: ResolvedComposerSelectorState;
  defaults: ComposerWorkerDefaults;
  composerModelGroups: ComposerModelGroup[];
  onModeChange: (mode: ResolvedComposerSelectorState['mode']) => void;
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  onEffortChange: (effort: ThinkingEffort) => void;
  onRuntimeChange: (runtime: OrchestratorRuntime) => void;
  onWorkerModelChange: (model: string | null) => void;
  onWorkerStartModeChange: (mode: WorkerStartMode) => void;
  saving?: boolean;
  leadingControls?: ReactNode;
  attachControl?: ReactNode;
  meterControl?: ReactNode;
  micControl?: ReactNode;
  voiceControl?: ReactNode;
  sendControl?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  onRequestTextareaFocus?: () => void;
}) {
  return (
    <div
      ref={containerRef}
      data-testid="composer-selector-footer"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 36,
        paddingTop: 4,
        paddingRight: 8,
        paddingBottom: 8,
        paddingLeft: 8,
      }}
    >
      <ModeChip state={state} onModeChange={onModeChange} />
      <span data-testid="composer-selector-attach" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{attachControl}</span>
      {leadingControls ? (
        <span data-testid="composer-selector-leading-controls" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
          {leadingControls}
        </span>
      ) : null}
      <span data-testid="composer-selector-spacer" style={{ flex: 1, minWidth: 0 }} />
      {meterControl ? (
        <span data-testid="composer-selector-meter" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {meterControl}
        </span>
      ) : null}
      <ComposerPicker
        state={state}
        defaults={defaults}
        composerModelGroups={composerModelGroups}
        onModelChange={onModelChange}
        onBackendChange={onBackendChange}
        onEffortChange={onEffortChange}
        onRuntimeChange={onRuntimeChange}
        onWorkerModelChange={onWorkerModelChange}
        onWorkerStartModeChange={onWorkerStartModeChange}
        onRequestTextareaFocus={onRequestTextareaFocus}
        saving={saving}
      />
      <span data-testid="composer-selector-mic" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{micControl}</span>
      {voiceControl ? <span data-testid="composer-selector-voice" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{voiceControl}</span> : null}
      <span data-testid="composer-selector-send" style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>{sendControl}</span>
    </div>
  );
}

export function ComposerSelectorFooter({
  mode,
  onModeChange,
  modelId,
  modelLabel,
  activeBackend,
  onModelChange,
  onBackendChange,
  effort,
  onEffortChange,
  adaptiveEnabled,
  operatorDefaultEffort = effort,
  isFreePlan = false,
  threadId = null,
  ...viewProps
}: {
  input: string;
  mode: ComposerSelectorMode;
  onModeChange: (mode: ComposerSelectorMode) => void;
  modelId: string;
  modelLabel: string;
  activeBackend: OrchestratorBackendSetting;
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  effort: ThinkingEffort;
  onEffortChange: (effort: ThinkingEffort) => void;
  adaptiveEnabled: boolean;
  operatorDefaultEffort?: ThinkingEffort;
  isFreePlan?: boolean;
  threadId?: string | null;
  leadingControls?: ReactNode;
  attachControl?: ReactNode;
  meterControl?: ReactNode;
  micControl?: ReactNode;
  voiceControl?: ReactNode;
  sendControl?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  onRequestTextareaFocus?: () => void;
}) {
  const controller = useComposerSelectorState({
    enabled: true,
    mode,
    modelId,
    modelLabel,
    backend: activeBackend,
    effort,
    operatorDefaultEffort,
    adaptiveEnabled,
    threadId,
    isFreePlan,
    initialEffortIsSessionOverride: true,
    onModeChange,
    onModelChange,
    onBackendChange,
    onEffortChange,
  });
  return (
    <ComposerSelectorFooterView
      {...viewProps}
      state={controller.state}
      defaults={controller.defaults}
      composerModelGroups={controller.composerModelGroups}
      onModeChange={controller.onModeChange}
      onModelChange={controller.onModelChange}
      onBackendChange={controller.onBackendChange}
      onEffortChange={controller.onEffortChange}
      onRuntimeChange={controller.onRuntimeChange}
      onWorkerModelChange={controller.onWorkerModelChange}
      onWorkerStartModeChange={controller.onWorkerStartModeChange}
      saving={controller.savingWorkerDefaults}
    />
  );
}
