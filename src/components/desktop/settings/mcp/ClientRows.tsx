import type React from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
} from '../shared';

export type Target = 'claude-desktop' | 'claude-code';
export type ExternalTarget = 'hermes' | 'openclaw';
export type AnyTarget = Target | ExternalTarget;

export interface ClaudeTargetStatus {
  target: Target;
  path: string;
  fileExists: boolean;
  alreadyRegistered: boolean;
  alreadyUpToDate: boolean;
  setupReady?: boolean;
  setupBlockedDetail?: string | null;
  otherServers: string[];
  size: number;
}

export interface ExternalTargetStatus {
  target: ExternalTarget;
  installed: boolean;
  cliPath: string | null;
  registered: boolean;
  hint?: string;
}

export function ClaudeTargetRow({
  status,
  installing,
  disabled = false,
  note,
  onInstall,
  onRemove,
  restartHint,
}: {
  target: Target;
  status: ClaudeTargetStatus | null;
  installing: boolean;
  disabled?: boolean;
  note: { target: AnyTarget; message: string; ok: boolean } | null;
  onInstall: () => void;
  onRemove: () => void;
  restartHint: string;
}) {
  const connected = Boolean(status?.alreadyUpToDate);
  const needsUpdate = Boolean(status?.alreadyRegistered && !status?.alreadyUpToDate);
  const setupBlocked = status?.setupReady === false;

  const statusLine = !status
    ? 'Checking...'
    : setupBlocked
      ? status.setupBlockedDetail ?? 'Finish first launch, then connect again.'
      : connected
        ? 'Connected. o8 tools available in this client.'
        : needsUpdate
          ? 'Older o8 entry found. Update to the current config.'
          : status.fileExists
            ? `Ready to connect${status.otherServers.length > 0 ? ` (${status.otherServers.length} other server${status.otherServers.length === 1 ? '' : 's'} preserved)` : ''}.`
            : 'Not connected yet.';

  const primaryLabel = connected ? 'connected' : needsUpdate ? 'update' : 'install';
  const primaryDisabled = disabled || installing || connected || setupBlocked;

  return (
    <ClientRowShell disabled={disabled}>
      <div style={{ flex: 1, minWidth: 0, maxWidth: 520 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
          <BracketLabel tone={connected ? 'quiet' : 'accent'}>
            {setupBlocked ? 'not ready' : connected ? 'connected' : needsUpdate ? 'needs update' : 'not connected'}
          </BracketLabel>
        </div>
        <RowBody statusLine={statusLine} path={status?.path ?? null} note={note} restartHint={restartHint} />
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {status?.alreadyRegistered ? (
          <button type="button" onClick={onRemove} disabled={installing || disabled} style={quietActionStyle(installing || disabled)}>
            remove
          </button>
        ) : null}
        <button type="button" onClick={onInstall} disabled={primaryDisabled} style={accentActionStyle(primaryDisabled)}>
          {installing ? 'working...' : primaryLabel}
        </button>
      </div>
    </ClientRowShell>
  );
}

export function ExternalClientRow({
  target,
  status,
  installing,
  disabled = false,
  note,
  onInstall,
  onRemove,
  restartHint,
}: {
  target: ExternalTarget;
  status: ExternalTargetStatus | null;
  installing: boolean;
  disabled?: boolean;
  note: { target: AnyTarget; message: string; ok: boolean } | null;
  onInstall: () => void;
  onRemove: () => void;
  restartHint: string;
}) {
  const cliInstalled = Boolean(status?.installed);
  const registered = Boolean(status?.registered);
  const labelText = target === 'hermes' ? 'Hermes Agent' : 'OpenClaw';
  const statusLine = !status
    ? 'Checking...'
    : !cliInstalled
      ? `${labelText} CLI not found.`
      : registered
        ? `Connected. The o8 tools are wired into ${labelText}.`
        : `Ready to connect. ${labelText} CLI detected.`;
  const primaryDisabled = disabled || installing || !cliInstalled || registered;

  return (
    <ClientRowShell disabled={disabled}>
      <div style={{ flex: 1, minWidth: 0, maxWidth: 520 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
          <BracketLabel tone={registered ? 'quiet' : cliInstalled ? 'accent' : 'quiet'}>
            {!cliInstalled ? 'not installed' : registered ? 'connected' : 'not connected'}
          </BracketLabel>
        </div>
        <RowBody
          statusLine={statusLine}
          path={status?.cliPath ?? null}
          note={note}
          restartHint={restartHint}
          hint={!cliInstalled ? status?.hint : null}
        />
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        {registered ? (
          <button type="button" onClick={onRemove} disabled={installing || disabled} style={quietActionStyle(installing || disabled)}>
            remove
          </button>
        ) : null}
        <button type="button" onClick={onInstall} disabled={primaryDisabled} style={accentActionStyle(primaryDisabled)}>
          {installing ? 'working...' : registered ? 'connected' : 'install'}
        </button>
      </div>
    </ClientRowShell>
  );
}

function ClientRowShell({ disabled, children }: { disabled: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      paddingTop: 10,
      paddingBottom: 16,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
      opacity: disabled ? 0.55 : 1,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 20,
        flexWrap: 'wrap',
      }}>
        {children}
      </div>
    </div>
  );
}

function RowBody({
  statusLine,
  path,
  note,
  restartHint,
  hint,
}: {
  statusLine: string;
  path: string | null;
  note: { target: AnyTarget; message: string; ok: boolean } | null;
  restartHint: string;
  hint?: string | null;
}) {
  return (
    <>
      <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
        {statusLine}
      </div>
      {path ? (
        <div style={{
          marginTop: 6,
          fontFamily: MONO_FONT_STACK,
          fontSize: 11,
          letterSpacing: '0.02em',
          color: RAMS_INK_QUIET,
          wordBreak: 'break-all',
        }}>
          {path}
        </div>
      ) : null}
      {hint ? (
        <div style={{
          marginTop: 8,
          fontFamily: MONO_FONT_STACK,
          fontSize: 11,
          color: 'var(--t-text-muted)',
          lineHeight: 1.5,
          wordBreak: 'break-all',
        }}>
          {hint}
        </div>
      ) : null}
      {note ? (
        <div style={{
          marginTop: 8,
          fontSize: 12,
          lineHeight: 1.55,
          color: note.ok ? '#15803d' : '#dc2626',
        }}>
          {note.ok ? `${note.message} ${restartHint}` : note.message}
        </div>
      ) : null}
    </>
  );
}

function accentActionStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_CONTROL_BORDER : RAMS_CONTROL_ACTIVE_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_ACTIVE_BG,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize',
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}

function quietActionStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: RAMS_CONTROL_BORDER,
    background: disabled ? 'transparent' : RAMS_CONTROL_BG,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize',
    color: 'var(--t-text-muted)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  };
}
