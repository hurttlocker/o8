import type React from 'react';
import {
  MONO_FONT_STACK,
  RAMS_INK_QUIET,
  RamsButton,
} from '../shared';
import { SettingsRow, ValuePill } from '../grouped';

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
  label,
  status,
  installing,
  disabled = false,
  note,
  onInstall,
  onRemove,
  restartHint,
  divider = false,
}: {
  target: Target;
  label: string;
  status: ClaudeTargetStatus | null;
  installing: boolean;
  disabled?: boolean;
  note: { target: AnyTarget; message: string; ok: boolean } | null;
  onInstall: () => void;
  onRemove: () => void;
  restartHint: string;
  divider?: boolean;
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

  const primaryLabel = connected ? 'Connected' : needsUpdate ? 'Update' : 'Install';
  const primaryDisabled = disabled || installing || connected || setupBlocked;
  const pillTone = setupBlocked ? 'destructive' : connected ? 'success' : 'default';
  const pillLabel = setupBlocked ? 'Not ready' : connected ? 'Connected' : needsUpdate ? 'Needs update' : 'Not connected';

  return (
    <SettingsRow
      label={label}
      subtitle={<RowBody statusLine={statusLine} path={status?.path ?? null} note={note} restartHint={restartHint} />}
      accessory={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <ValuePill tone={pillTone}>{pillLabel}</ValuePill>
          {status?.alreadyRegistered ? (
            <RamsButton variant="ghost" onClick={onRemove} disabled={installing || disabled}>
              Remove
            </RamsButton>
          ) : null}
          <RamsButton variant="primary" onClick={onInstall} disabled={primaryDisabled} busy={installing}>
            {primaryLabel}
          </RamsButton>
        </div>
      }
      disabled={disabled}
      divider={divider}
    />
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
  divider = false,
}: {
  target: ExternalTarget;
  status: ExternalTargetStatus | null;
  installing: boolean;
  disabled?: boolean;
  note: { target: AnyTarget; message: string; ok: boolean } | null;
  onInstall: () => void;
  onRemove: () => void;
  restartHint: string;
  divider?: boolean;
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
  const pillTone = registered ? 'success' : cliInstalled ? 'default' : 'destructive';
  const pillLabel = !cliInstalled ? 'Not installed' : registered ? 'Connected' : 'Not connected';

  return (
    <SettingsRow
      label={labelText}
      subtitle={
        <RowBody
          statusLine={statusLine}
          path={status?.cliPath ?? null}
          note={note}
          restartHint={restartHint}
          hint={!cliInstalled ? status?.hint : null}
        />
      }
      accessory={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <ValuePill tone={pillTone}>{pillLabel}</ValuePill>
          {registered ? (
            <RamsButton variant="ghost" onClick={onRemove} disabled={installing || disabled}>
              Remove
            </RamsButton>
          ) : null}
          <RamsButton variant="primary" onClick={onInstall} disabled={primaryDisabled} busy={installing}>
            {registered ? 'Connected' : 'Install'}
          </RamsButton>
        </div>
      }
      disabled={disabled}
      divider={divider}
    />
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
      <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
        {statusLine}
      </div>
      {path ? (
        <div style={{
          marginTop: 4,
          fontFamily: MONO_FONT_STACK,
          fontSize: 10.5,
          letterSpacing: '0.02em',
          color: RAMS_INK_QUIET,
          wordBreak: 'break-all',
        }}>
          {path}
        </div>
      ) : null}
      {hint ? (
        <div style={{
          marginTop: 6,
          fontFamily: MONO_FONT_STACK,
          fontSize: 10.5,
          color: 'var(--t-text-muted)',
          lineHeight: 1.4,
          wordBreak: 'break-all',
        }}>
          {hint}
        </div>
      ) : null}
      {note ? (
        <div style={{
          marginTop: 6,
          fontSize: 11.5,
          lineHeight: 1.45,
          color: note.ok ? '#15803d' : '#dc2626',
        }}>
          {note.ok ? `${note.message} ${restartHint}` : note.message}
        </div>
      ) : null}
    </>
  );
}
