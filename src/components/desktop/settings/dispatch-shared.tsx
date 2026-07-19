'use client';

/**
 * Shared types, option constants, and the PickerMenu control for the Dispatch
 * settings tab (OperatorDefaultsTab + DispatchFoundersSection). Split out so
 * the Founders section can live in its own file without circular imports
 * (epic #1450 — settings professionalization).
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MODEL_IDS } from '@/lib/models';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_INK_QUIET,
} from './shared';

export type OverlapGateMode = 'advisory' | 'strict';
export type { ThinkingEffort };
export type SettingSource = 'env' | 'file' | 'default';

export type SubscriptionProfile = 'both' | 'claude-only' | 'codex-only';
export type DispatchRuntime = 'codex' | 'claude-code' | 'gemini' | 'antigravity' | 'opencode' | 'cursor' | 'grok' | 'pi';
export type ClassAComposer = 'auto' | 'haiku-cli' | 'sonnet-cli' | 'fastest';
export type WorkersUseBrain = 'off' | 'auto' | 'all';
export type OrchestratorBackendSetting = 'auto' | 'codex' | 'claude' | 'openclaw' | 'hermes' | 'collide';
export type ReviewerBackendSetting = 'follow' | 'codex' | 'claude';
export type AutoApplyUpdates = 'off' | 'when-idle';
export type CollideAggregator = 'auto' | 'claude' | 'codex';
export type PrLinkDestination = 'in-app' | 'browser';

export interface TargetingTierUI {
  runtime: DispatchRuntime;
  model: string;
  effort: ThinkingEffort;
}

export interface OperatorDefaults {
  subscriptionProfile: SubscriptionProfile;
  parallelCap: number;
  overlapGate: OverlapGateMode;
  healBotEnabled: boolean;
  supervisorAutoEscalate: boolean;
  reviewContinuation: boolean;
  thinkingEffort: ThinkingEffort;
  promptCachingEnabled: boolean;
  orchestratorModel: string;
  defaultDispatchRuntime: DispatchRuntime;
  codexWorkerEffort: ThinkingEffort;
  claudeWorkerEffort: ThinkingEffort;
  defaultDispatchModel: string;
  localInferenceBaseUrl: string;
  localEmbedModel: string;
  localChatModel: string;
  experimentalOpencode: boolean;
  experimentalGemini: boolean;
  experimentalChat: boolean;
  experimentalCanvas: boolean;
  nativeBrowserView: boolean;
  classAComposer: ClassAComposer;
  inAppOrchestratorEnabled: boolean;
  brainUseClaudeCli: boolean;
  workersUseBrain: WorkersUseBrain;
  orchestratorBackend: OrchestratorBackendSetting;
  reviewerBackend: ReviewerBackendSetting;
  packetExplainerEnabled: boolean;
  quizGateEnabled: boolean;
  buyinDocEnabled: boolean;
  targetingTriage: TargetingTierUI;
  targetingAction: TargetingTierUI;
  autoApplyUpdates: AutoApplyUpdates;
  collideAggregator: CollideAggregator;
  telemetryOptIn: boolean;
  telemetryIngestUrl: string;
  crashReportsEnabled: boolean;
  branchPrefix: string;
  commitAttributionEnabled: boolean;
  prLinkDestination: PrLinkDestination;
}

export interface OperatorDefaultsResponse {
  values: OperatorDefaults;
  sources: Record<keyof OperatorDefaults, SettingSource>;
  cliAuth?: {
    statuses: Record<'codex' | 'claude', {
      installed: boolean;
      authenticated: boolean;
      detail: string;
      fix: string;
    }>;
    suggestedSubscriptionProfile: {
      profile: SubscriptionProfile | null;
      detail: string | null;
    };
  };
}

export const ENV_LOCKED_REASON = 'Locked by an environment variable — unset it to manage from Settings.';

export const SUBSCRIPTION_PROFILE_OPTIONS: Array<{ value: SubscriptionProfile; label: string; detail: string }> = [
  { value: 'both', label: 'Both houses', detail: 'Use Claude and Codex together with the existing paired defaults.' },
  { value: 'claude-only', label: 'Claude only', detail: 'Everything runs on your Claude subscription — Opus orchestrates, Sonnet works, escalates only when needed.' },
  { value: 'codex-only', label: 'Codex / OpenAI only', detail: 'Everything runs on Codex / OpenAI — GPT-5.6 Sol orchestrates, Terra works, escalates to Sol when needed.' },
];

export const THINKING_EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string; detail: string }> = [
  { value: 'adaptive', label: 'Adaptive', detail: 'Let the model choose.' },
  { value: 'low', label: 'Low', detail: 'Quick answers.' },
  { value: 'medium', label: 'Medium', detail: 'Balanced cost and quality.' },
  { value: 'high', label: 'High', detail: 'Deeper reasoning, more tokens.' },
  { value: 'max', label: 'Max', detail: 'Highest effort allowed.' },
  { value: 'xhigh', label: 'Extended', detail: 'Extended thinking budget.' },
];

export const CODEX_WORKER_EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string; detail: string }> = [
  { value: 'adaptive', label: 'Runtime default', detail: 'Leave Codex at its default.' },
  { value: 'low', label: 'Low', detail: 'Quick worker turns.' },
  { value: 'medium', label: 'Medium', detail: 'Balanced cost and quality.' },
  { value: 'high', label: 'High', detail: 'Deeper worker reasoning.' },
  { value: 'xhigh', label: 'Extended', detail: 'Codex top effort.' },
];

export const CLAUDE_WORKER_EFFORT_OPTIONS: Array<{ value: ThinkingEffort; label: string; detail: string }> = [
  { value: 'adaptive', label: 'Runtime default', detail: 'Leave Claude Code at its default.' },
  { value: 'low', label: 'Low', detail: 'Quick worker turns.' },
  { value: 'medium', label: 'Medium', detail: 'Balanced cost and quality.' },
  { value: 'high', label: 'High', detail: 'Deeper worker reasoning.' },
  { value: 'max', label: 'Max', detail: 'Claude Code top effort.' },
];

export const ORCHESTRATOR_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: MODEL_IDS.raw.anthropicClaudeFable5, label: 'Fable 5' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus48, label: 'Opus 4.8' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus47, label: 'Opus 4.7' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus46, label: 'Opus 4.6' },
  { value: MODEL_IDS.raw.anthropicClaudeSonnet5, label: 'Sonnet 5' },
  { value: MODEL_IDS.raw.anthropicClaudeSonnet45, label: 'Sonnet 4.5' },
  { value: MODEL_IDS.raw.anthropicClaudeHaiku45, label: 'Haiku 4.5' },
];

export const DISPATCH_RUNTIME_OPTIONS: Array<{ value: DispatchRuntime; label: string; detail: string }> = [
  { value: 'codex', label: 'Codex', detail: 'OpenAI CLI — the default workhorse (GPT-5.6 Terra workers).' },
  { value: 'claude-code', label: 'Claude Code', detail: 'Anthropic CLI — pairs opposite Codex orchestration.' },
  { value: 'grok', label: 'Grok Build', detail: 'xAI Grok Build CLI — Grok 4.5 (Opus-class), sub-billed via SuperGrok.' },
  { value: 'cursor', label: 'Cursor', detail: 'Cursor CLI — subscription or CURSOR_API_KEY authenticated.' },
  { value: 'gemini', label: 'Gemini', detail: 'Google Gemini 3 Pro CLI — fastest for parallel fan-out.' },
  { value: 'opencode', label: 'opencode', detail: 'OSS CLI — routes through your configured provider keys.' },
];

export const PICKER_MENU_POPOVER_BG = 'var(--t-panel-solid)';

export function PickerMenu<T extends string>({ value, options, onChange, disabled, minWidth }: {
  value: T;
  options: Array<{ value: T; label: string; detail?: string }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const active = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (disabled) return;
          const next = !open;
          setAnchorRect(next ? triggerRef.current?.getBoundingClientRect() ?? null : null);
          setOpen(next);
        }}
        style={{
          minWidth: minWidth ?? 140,
          minHeight: 44,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 14,
          paddingRight: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: open ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER,
          borderRadius: 9,
          background: RAMS_CONTROL_BG,
          color: 'var(--t-text)',
          fontSize: 12,
          fontWeight: 400,
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: APP_FONT_STACK,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          opacity: disabled ? 0.6 : 1,
          letterSpacing: '-0.005em',
          transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <span>{active?.label ?? value}</span>
        <svg
          width={11}
          height={11}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)', color: RAMS_INK_QUIET }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && !disabled && anchorRect && typeof document !== 'undefined' ? createPortal((
        <div
          ref={popoverRef}
          role="listbox"
          aria-label="Settings picker options"
          onMouseDown={(event) => event.preventDefault()}
          style={{
            position: 'fixed',
            top: anchorRect.bottom + 6,
            right: Math.max(8, window.innerWidth - anchorRect.right),
            minWidth: minWidth ?? 220,
            border: `1px solid ${RAMS_CONTROL_BORDER}`,
            borderRadius: 9,
            background: PICKER_MENU_POPOVER_BG,
            zIndex: 20,
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 0,
            paddingRight: 0,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 280,
            overflowY: 'auto',
            boxShadow: 'var(--t-panel-shadow)',
          }}
        >
          {options.map((opt) => {
            const isActive = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  minHeight: 44,
                  justifyContent: 'center',
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 12,
                  paddingRight: 12,
                  border: 'none',
                  background: 'transparent',
                  color: isActive ? RAMS_ACCENT : 'var(--t-text)',
                  fontSize: 12,
                  fontWeight: isActive ? 500 : 400,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: APP_FONT_STACK,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  letterSpacing: '-0.005em',
                }}
              >
                <span>{opt.label}</span>
                {opt.detail ? (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 400,
                    color: RAMS_INK_QUIET,
                    fontFamily: APP_FONT_STACK,
                  }}>
                    {opt.detail}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ), document.body) : null}
    </div>
  );
}
