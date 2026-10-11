'use client';

import { useCallback, useEffect, useState } from 'react';
import { Smartphone } from '../lucide-shims';
import { RamsButton } from './shared';
import { SettingsGroup, SettingsRow } from './grouped';

interface GroupAccess {
  id: string;
  label: string;
  memberSuffixes: string[];
  approvalVersion: string;
  fullAccess: boolean;
  canGrant: boolean;
}

interface AccessResponse {
  ok: boolean;
  configured?: boolean;
  enabled?: boolean;
  executionBackend?: 'cli' | 'openclaw';
  openclawConfigured?: boolean;
  directSenderSuffix?: string | null;
  groups?: GroupAccess[];
  group?: GroupAccess;
  error?: string;
}

export function SymonIMessageAccessSection({ nativeReceiverEnabled = false, mutationLocked = false, acquireMutation, releaseMutation, onWriteSettled }: {
  nativeReceiverEnabled?: boolean | null;
  mutationLocked?: boolean;
  acquireMutation?: () => boolean;
  releaseMutation?: () => void;
  onWriteSettled?: (error: string | null) => void;
}) {
  const [groups, setGroups] = useState<GroupAccess[]>([]);
  const [configured, setConfigured] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [executionBackend, setExecutionBackend] = useState<'cli' | 'openclaw'>('cli');
  const [openclawConfigured, setOpenclawConfigured] = useState(false);
  const [directSenderSuffix, setDirectSenderSuffix] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    void fetch('/api/panel/symon/imessage-access', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as AccessResponse;
        if (!response.ok || !data.ok) throw new Error('Could not read iMessage group access.');
        if (cancelled) return;
        setConfigured(data.configured === true);
        setEnabled(data.enabled === true);
        setExecutionBackend(data.executionBackend ?? 'cli');
        setOpenclawConfigured(data.openclawConfigured === true);
        setDirectSenderSuffix(data.directSenderSuffix ?? null);
        setGroups(data.groups ?? []);
      })
      .catch(() => { if (!cancelled) setError('Could not read iMessage group access.'); });
    return () => { cancelled = true; controller.abort(); };
  }, [nativeReceiverEnabled]);

  const saveBackend = useCallback(async (next: 'cli' | 'openclaw') => {
    if (nativeReceiverEnabled !== false || mutationLocked || acquireMutation?.() === false) return;
    let mutationError: string | null = null;
    setBusyId('backend');
    setError(null);
    try {
      const response = await fetch('/api/panel/symon/imessage-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionBackend: next }),
      });
      const data = await response.json() as AccessResponse;
      if (!response.ok || !data.ok || data.executionBackend !== next) {
        throw new Error('Could not change the iMessage agent engine. Check that OpenClaw is connected to Symon.');
      }
      setExecutionBackend(next);
    } catch (failure) {
      mutationError = failure instanceof Error ? failure.message : 'Could not change the iMessage agent engine.';
      setError(mutationError);
    } finally {
      setBusyId(null);
      onWriteSettled?.(mutationError);
      releaseMutation?.();
    }
  }, [nativeReceiverEnabled, mutationLocked, acquireMutation, onWriteSettled, releaseMutation]);

  const saveEnabled = useCallback(async (next: boolean) => {
    if (nativeReceiverEnabled !== false || mutationLocked || acquireMutation?.() === false) return;
    let mutationError: string | null = null;
    setBusyId('master');
    setError(null);
    try {
      const response = await fetch('/api/panel/symon/imessage-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await response.json() as AccessResponse;
      if (!response.ok || !data.ok || data.enabled !== next) throw new Error('Could not change iMessage routing.');
      setEnabled(next);
      if (!next) setPendingId(null);
    } catch (failure) {
      mutationError = failure instanceof Error ? failure.message : 'Could not change iMessage routing.';
      setError(mutationError);
    } finally {
      setBusyId(null);
      onWriteSettled?.(mutationError);
      releaseMutation?.();
    }
  }, [nativeReceiverEnabled, mutationLocked, acquireMutation, onWriteSettled, releaseMutation]);

  const save = useCallback(async (group: GroupAccess, fullAccess: boolean) => {
    if (nativeReceiverEnabled !== false || mutationLocked || acquireMutation?.() === false) return;
    let mutationError: string | null = null;
    const groupId = group.id;
    setBusyId(groupId);
    setError(null);
    try {
      const response = await fetch('/api/panel/symon/imessage-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId,
          fullAccess,
          ...(fullAccess ? {
            confirm: 'grant-all-approved-members',
            approvalVersion: group.approvalVersion,
          } : {}),
        }),
      });
      const data = await response.json() as AccessResponse;
      if (data.error === 'membership_changed') {
        const refreshed = await fetch('/api/panel/symon/imessage-access', { cache: 'no-store' });
        const updated = await refreshed.json() as AccessResponse;
        if (refreshed.ok && updated.ok) setGroups(updated.groups ?? []);
        setPendingId(null);
        throw new Error('Approved members changed. Review the updated list before enabling full access.');
      }
      if (!response.ok || !data.ok || !data.group) throw new Error('Could not change group access.');
      setGroups((current) => current.map((group) => group.id === groupId ? data.group! : group));
      setPendingId(null);
    } catch (failure) {
      mutationError = failure instanceof Error ? failure.message : 'Could not change group access.';
      setError(mutationError);
    } finally {
      setBusyId(null);
      onWriteSettled?.(mutationError);
      releaseMutation?.();
    }
  }, [nativeReceiverEnabled, mutationLocked, acquireMutation, onWriteSettled, releaseMutation]);

  if (!configured) return null;

  return (
    <section style={{ marginTop: 28 }}>
      <SettingsGroup
        header="iMessage bridge access"
        footnote={error ?? 'These controls belong to the existing OpenClaw / CLI bridge. The native Messages receiver has its own authorized senders above. Only one receiver can answer at a time.'}
      >
        <SettingsRow
          icon={<Smartphone size={14} />}
          label="Allow Symon on iMessage"
          subtitle={nativeReceiverEnabled === null
            ? 'Check native Messages receiver status above before changing the bridge'
            : nativeReceiverEnabled
              ? 'Disabled while the native Messages receiver is enabled'
              : directSenderSuffix
            ? `${enabled ? 'On' : 'Off'} · Your approved direct number ends ${directSenderSuffix}`
            : enabled ? 'Symon is available in approved chats' : 'Symon will not reply to iMessage chats'}
          checked={nativeReceiverEnabled ? false : enabled}
          onToggle={(next) => { void saveEnabled(next); }}
          disabled={busyId !== null || mutationLocked || nativeReceiverEnabled !== false}
        />
        <SettingsRow
          icon={<Smartphone size={14} />}
          label="Use OpenClaw for iMessage"
          subtitle={openclawConfigured
            ? 'Symon runs through the connected OpenClaw agent; the CLI remains the default for other users.'
            : 'Connect a Symon agent to iMessage in OpenClaw to enable this.'}
          checked={executionBackend === 'openclaw'}
          onToggle={(next) => { void saveBackend(next ? 'openclaw' : 'cli'); }}
          disabled={busyId !== null || mutationLocked || nativeReceiverEnabled !== false || (!openclawConfigured && executionBackend !== 'openclaw')}
        />
        {groups.map((group) => (
          <div key={group.id}>
            <SettingsRow
              icon={<Smartphone size={14} />}
              label={group.label}
              subtitle={group.canGrant
                ? `${group.fullAccess ? 'Full access' : 'Limited access'} · Approved members ending ${group.memberSuffixes.join(', ')}`
                : 'Verify group members before granting full access'}
              checked={group.fullAccess}
              onToggle={(next) => {
                if (next) setPendingId(group.id);
                else void save(group, false);
              }}
              disabled={busyId !== null || mutationLocked || nativeReceiverEnabled !== false || !group.canGrant}
            />
            {pendingId === group.id && nativeReceiverEnabled === false ? (
              <div style={{
                borderTopWidth: 1,
                borderTopStyle: 'solid',
                borderTopColor: 'var(--t-divider-subtle)',
                paddingTop: 12,
                paddingRight: 14,
                paddingBottom: 12,
                paddingLeft: 14,
              }}>
                <p style={{ marginTop: 0, marginRight: 0, marginBottom: 10, marginLeft: 0, color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.45 }}>
                  Give these approved members the same Symon tool access you have on this Mac?
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <RamsButton onClick={() => void save(group, true)} busy={busyId === group.id} disabled={mutationLocked}>Grant full access</RamsButton>
                  <RamsButton variant="ghost" onClick={() => setPendingId(null)} disabled={busyId !== null || mutationLocked}>Cancel</RamsButton>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </SettingsGroup>
    </section>
  );
}
