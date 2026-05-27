'use client';

/**
 * Factory-reset confirmation + done modals extracted from `DiagnosticsTab.tsx`
 * to keep the parent file under the 800-line ceiling after #796 added the
 * Loop Status section. No behavior change — both components are pure
 * presentation, fed by props from the parent.
 */

import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_INK_QUIET,
  RamsButton,
} from './shared';

export type FactoryResetStage = 'idle' | 'confirm' | 'busy' | 'done' | 'error';

export interface FactoryResetResult {
  dataDir: string;
  removed: string[];
  failed: { entry: string; error: string }[];
  durationMs: number;
}

export function ResetConfirmModal({
  stage,
  confirmText,
  onConfirmTextChange,
  error,
  onCancel,
  onSubmit,
}: {
  stage: FactoryResetStage;
  confirmText: string;
  onConfirmTextChange: (v: string) => void;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const ready = confirmText === 'RESET' && stage !== 'busy';

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.42)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{
        width: 480,
        maxWidth: '90vw',
        background: 'var(--t-bg-card, #ffffff)',
        border: `1px solid ${RAMS_HAIRLINE}`,
        borderRadius: 4,
        paddingTop: 24,
        paddingRight: 28,
        paddingBottom: 24,
        paddingLeft: 28,
        boxShadow: '0 12px 48px rgba(0, 0, 0, 0.18)',
      }}>
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 300,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: '#d94f3a',
          marginBottom: 14,
        }}>
          DANGER · IRREVERSIBLE
        </div>
        <div style={{
          fontSize: 18,
          fontWeight: 300,
          color: 'var(--t-text)',
          letterSpacing: '-0.02em',
          marginBottom: 14,
        }}>
          Factory reset o8
        </div>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, marginBottom: 18 }}>
          This will permanently delete everything inside{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.o8</span>:
        </div>
        <ul style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.7,
          paddingLeft: 18,
          marginTop: 0,
          marginBottom: 18,
        }}>
          <li>SQLite database (sessions, approvals, lanes, watched agents)</li>
          <li>Encrypted API keys (Anthropic, OpenAI, Gemini, etc.)</li>
          <li>Mission state and orchestrator history</li>
          <li>Watched repo registry, directives, WS token</li>
          <li>Per-server logs</li>
        </ul>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, marginBottom: 18 }}>
          The macOS Keychain master key and{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.cortex-ide</span>{' '}
          (legacy rollback dir) are left untouched.
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
            marginBottom: 6,
          }}>
            Type RESET to confirm
          </div>
          <input
            type="text"
            value={confirmText}
            onChange={(event) => onConfirmTextChange(event.target.value)}
            disabled={stage === 'busy'}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: MONO_FONT_STACK,
              fontSize: 13,
              fontWeight: 400,
              letterSpacing: '0.04em',
              color: 'var(--t-text)',
              background: 'var(--t-input-bg, transparent)',
              border: `1px solid ${RAMS_HAIRLINE}`,
              borderRadius: 4,
              paddingTop: 9,
              paddingRight: 12,
              paddingBottom: 9,
              paddingLeft: 12,
              outline: 'none',
            }}
          />
        </div>
        {error ? (
          <div style={{
            marginBottom: 14,
            paddingTop: 2,
            paddingBottom: 2,
            fontSize: 12,
            color: 'var(--t-text)',
            lineHeight: 1.5,
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#ef4444',
              marginRight: 8,
            }}>
              [error]
            </span>
            {error}
          </div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
          <RamsButton variant="ghost" onClick={onCancel} disabled={stage === 'busy'}>
            cancel
          </RamsButton>
          <RamsButton
            variant="danger"
            onClick={onSubmit}
            disabled={!ready}
            busy={stage === 'busy'}
          >
            {stage === 'busy' ? 'wiping...' : 'reset everything'}
          </RamsButton>
        </div>
      </div>
    </div>
  );
}

export function ResetDoneModal({
  result,
  onDismiss,
}: {
  result: FactoryResetResult;
  onDismiss: () => void;
}) {
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.42)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{
        width: 460,
        maxWidth: '90vw',
        background: 'var(--t-bg-card, #ffffff)',
        border: `1px solid ${RAMS_HAIRLINE}`,
        borderRadius: 4,
        paddingTop: 24,
        paddingRight: 28,
        paddingBottom: 24,
        paddingLeft: 28,
        boxShadow: '0 12px 48px rgba(0, 0, 0, 0.18)',
      }}>
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 300,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: RAMS_ACCENT,
          marginBottom: 14,
        }}>
          RESET COMPLETE
        </div>
        <div style={{
          fontSize: 18,
          fontWeight: 300,
          color: 'var(--t-text)',
          letterSpacing: '-0.02em',
          marginBottom: 12,
        }}>
          Quit and reopen o8 to reinitialize
        </div>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, marginBottom: 16 }}>
          {result.removed.length} entries removed in {result.durationMs}ms.{' '}
          {result.failed.length > 0
            ? `${result.failed.length} entries could not be deleted (likely held open by the running app — they will be cleared on next launch).`
            : 'The current session is still running against the deleted database — close o8 fully and relaunch before continuing.'}
        </div>
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 11,
          letterSpacing: '0.02em',
          color: RAMS_INK_QUIET,
          marginBottom: 18,
          wordBreak: 'break-all',
        }}>
          {result.dataDir}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <RamsButton variant="ghost" onClick={onDismiss}>
            close
          </RamsButton>
        </div>
      </div>
    </div>
  );
}
