'use client';

/**
 * ModePicker — renders below IntentChips when the composer has text.
 *
 * Two side-by-side mode cards (#888/#892):
 *   - LEFT  — "Fleet orchestration" — Claude orchestrates Codex +
 *             Gemini + opencode in parallel waves. Tagged "using Claude
 *             Opus 4.7".
 *   - RIGHT — "Single runtime" — collapsible runtime sub-picker
 *             (Codex / Gemini / opencode / Claude Code). Dispatches one
 *             agent without orchestration overhead.
 *
 * Selected card has a subtle orange border (one orange accent rule).
 * Default = Fleet on first dispatch, last-used after that. Persisted
 * per-workspace via localStorage `cortex-ide:orchestrator:mode:<key>`.
 *
 * No native form controls. Inline styles + theme tokens. Reduced-motion
 * is honored — no card mount animation when set.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import type { OrchestrationMode, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { useExperimentalOpencodeFlag } from '@/lib/operator/use-experimental-opencode';
import { ChatModelPicker } from './ChatModelPicker';
import { getChatModelOption, type ChatModelId } from './chat-models';

export type { ChatModelId, OrchestrationMode };
export { CHAT_MODEL_OPTIONS } from './chat-models';

interface ModePickerProps {
  visible: boolean;
  workspaceKey: string;
  selectedMode: OrchestrationMode;
  onSelectMode: (mode: OrchestrationMode) => void;
  selectedSingleRuntime: OrchestratorRuntime;
  onSelectSingleRuntime: (runtime: OrchestratorRuntime) => void;
  selectedChatModelId: ChatModelId;
  onSelectChatModel: (modelId: ChatModelId) => void;
}

const SINGLE_RUNTIMES: Array<{ id: OrchestratorRuntime; label: string }> = [
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'opencode', label: 'opencode' },
  { id: 'claude-code', label: 'Claude Code' },
];

function ModePickerBase({
  visible,
  workspaceKey,
  selectedMode,
  onSelectMode,
  selectedSingleRuntime,
  onSelectSingleRuntime,
  selectedChatModelId,
  onSelectChatModel,
}: ModePickerProps) {
  const opencodeEnabled = useExperimentalOpencodeFlag();
  const visibleRuntimes = useMemo(
    () => (opencodeEnabled ? SINGLE_RUNTIMES : SINGLE_RUNTIMES.filter((r) => r.id !== 'opencode')),
    [opencodeEnabled],
  );
  const selectedChatModel = getChatModelOption(selectedChatModelId);
  // Whether the runtime sub-picker drawer is open. We derive openness
  // from selectedMode + an explicit user toggle in the same setter so we
  // never have to "sync" two states inside an effect (per react-hooks/
  // set-state-in-effect lint rule).
  const [singleOpen, setSingleOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const effectiveSingleOpen = selectedMode === 'single' && singleOpen;
  const effectiveChatOpen = selectedMode === 'chat' && chatOpen;

  const handleClickFleet = useCallback(() => {
    onSelectMode('fleet');
  }, [onSelectMode]);

  const handleClickSingle = useCallback(() => {
    onSelectMode('single');
    setSingleOpen(true);
  }, [onSelectMode]);

  const handleClickChat = useCallback(() => {
    onSelectMode('chat');
    setChatOpen(true);
  }, [onSelectMode]);

  if (!visible) return null;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 8,
        paddingTop: 4,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
      }}
    >
      <ModeCard
        active={selectedMode === 'fleet'}
        title="Fleet orchestration"
        copy="Claude orchestrates Codex + Gemini + opencode in parallel waves."
        tag="using Claude Opus 4.7"
        onClick={handleClickFleet}
        glyph={<FleetGlyph />}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ModeCard
          active={selectedMode === 'single'}
          title="Single runtime"
          copy="Dispatches one agent without orchestration overhead."
          tag={`using ${SINGLE_RUNTIMES.find((r) => r.id === selectedSingleRuntime)?.label ?? selectedSingleRuntime}`}
          onClick={handleClickSingle}
          glyph={<SingleGlyph />}
        />
        {effectiveSingleOpen ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              paddingTop: 4,
              paddingRight: 4,
              paddingBottom: 4,
              paddingLeft: 4,
            }}
          >
            {visibleRuntimes.map((runtime) => {
              const selected = runtime.id === selectedSingleRuntime;
              return (
                <button
                  key={runtime.id}
                  type="button"
                  onClick={() => onSelectSingleRuntime(runtime.id)}
                  aria-pressed={selected}
                  style={{
                    height: 22,
                    paddingTop: 0,
                    paddingRight: 8,
                    paddingBottom: 0,
                    paddingLeft: 8,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: selected ? 'var(--t-accent-border)' : 'var(--t-border)',
                    background: selected ? 'var(--t-accent-soft)' : 'transparent',
                    color: selected ? 'var(--t-accent)' : 'var(--t-text-muted)',
                    fontSize: 9,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    cursor: 'pointer',
                    fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
                  }}
                >
                  {runtime.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ModeCard
          active={selectedMode === 'chat'}
          title="Chat"
          copy="Talk to o8 about anything. Pick a model, no dispatch."
          tag={`using ${selectedChatModel.label}`}
          onClick={handleClickChat}
          glyph={<ChatGlyph />}
        />
        {effectiveChatOpen ? (
          <ChatModelPicker
            workspaceKey={workspaceKey}
            selectedModelId={selectedChatModelId}
            onSelectModel={onSelectChatModel}
          />
        ) : null}
      </div>
    </div>
  );
}

interface ModeCardProps {
  active: boolean;
  title: string;
  copy: string;
  tag: string;
  onClick: () => void;
  glyph: React.ReactNode;
}

function ModeCard({ active, title, copy, tag, onClick, glyph }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 6,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-divider-subtle)',
        background: active ? 'var(--t-accent-soft)' : 'var(--t-bg-card)',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        transition: 'border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), background 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.borderColor = 'var(--t-border)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-muted)' }}>
          {glyph}
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.005em',
          }}
        >
          {title}
        </span>
      </div>
      <span
        style={{
          fontSize: 10.5,
          color: 'var(--t-text-muted)',
          lineHeight: 1.45,
        }}
      >
        {copy}
      </span>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          color: 'var(--t-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
        }}
      >
        {tag}
      </span>
    </button>
  );
}

function FleetGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 8v4" />
      <path d="m12 12-6 4" />
      <path d="m12 12 6 4" />
    </svg>
  );
}

function SingleGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

export const ModePicker = memo(ModePickerBase);

export function loadOrchestrationMode(workspaceKey: string): { mode: OrchestrationMode; runtime: OrchestratorRuntime } {
  if (typeof window === 'undefined') return { mode: 'fleet', runtime: 'codex' };
  try {
    const raw = window.localStorage.getItem(`cortex-ide:orchestrator:mode:${workspaceKey}`);
    if (!raw) return { mode: 'fleet', runtime: 'codex' };
    const parsed = JSON.parse(raw) as { mode?: string; runtime?: string };
    const mode: OrchestrationMode = parsed.mode === 'single' || parsed.mode === 'chat' ? parsed.mode : 'fleet';
    const runtime: OrchestratorRuntime = parsed.runtime === 'gemini' || parsed.runtime === 'opencode' || parsed.runtime === 'claude-code' || parsed.runtime === 'codex'
      ? parsed.runtime
      : 'codex';
    return { mode, runtime };
  } catch {
    return { mode: 'fleet', runtime: 'codex' };
  }
}

export function persistOrchestrationMode(workspaceKey: string, mode: OrchestrationMode, runtime: OrchestratorRuntime): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`cortex-ide:orchestrator:mode:${workspaceKey}`, JSON.stringify({ mode, runtime }));
  } catch {
    // ignore
  }
}
