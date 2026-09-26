'use client';

import { useEffect, useRef, useState } from 'react';
import { PERMISSIONS, type PermId } from '@/components/desktop/settings/permissions-model';
import { onboardingButtonStyle, onboardingQuietButtonStyle } from './onboarding-style';
import { EMPTY_PERMISSIONS, PERMISSIONS_RESUME_KEY, readPermissionsResume, readOnboardingPermissions, requestOnboardingPermission, supportsPermissionCheck, type PermissionSnapshot } from './permissions-check';
import type { ProgressStorage } from './onboarding-progress';
import { useMicrophoneCheck } from './useMicrophoneCheck';

const reasons: Record<PermId, string> = {
  microphone: 'Talk and dictate in o8.',
  accessibility: 'Dictate into another app and use desktop controls.',
  'input-monitoring': 'Use voice shortcuts while another app is focused.',
  'screen-recording': 'Let screen-aware features see your screen when you use them.',
};
function ReadyMark({ size = 16 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>;
}
export function OnboardingPermissionsStep({ storage, onRestart, onContinue, onBusyChange }: {
  storage: ProgressStorage | null; onRestart: () => Promise<void>; onContinue: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const native = supportsPermissionCheck();
  const [statuses, setStatuses] = useState<PermissionSnapshot>(EMPTY_PERMISSIONS);
  const previous = useRef<PermissionSnapshot>(EMPTY_PERMISSIONS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [restartSuggested, setRestartSuggested] = useState(false);
  const [resumeMarker] = useState(() => readPermissionsResume(storage));
  const returned = Boolean(resumeMarker);
  const mic = useMicrophoneCheck();
  useEffect(() => { onBusyChange(Boolean(busy) || mic.busy); return () => onBusyChange(false); }, [busy, mic.busy, onBusyChange]);
  useEffect(() => {
    let cancelled = false;
    let checkedResume = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const next = await readOnboardingPermissions();
      if (cancelled) return;
      if (PERMISSIONS.some((item) => item.needsRelaunch && previous.current[item.id] !== 'unknown' && previous.current[item.id] !== 'granted' && next[item.id] === 'granted')) setRestartSuggested(true);
      previous.current = next;
      setStatuses(next);
      setChecked(true);
      if (returned && !checkedResume) {
        checkedResume = true;
        try { if (storage?.getItem(PERMISSIONS_RESUME_KEY) === resumeMarker) storage.removeItem(PERMISSIONS_RESUME_KEY); } catch { /* A saved return point may safely reopen this check. */ }
      }
      timer = setTimeout(() => void refresh(), 1500);
    };
    if (native) void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [native, returned, resumeMarker, storage]);
  const fix = async (id: PermId) => {
    setBusy(id); setError('');
    try { await requestOnboardingPermission(id, statuses[id]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open permissions. Try again.'); }
    finally { setBusy(null); }
  };
  const restart = async () => {
    mic.stop(); setBusy('restart'); setError('');
    try { await onRestart(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restart. Your place is saved.'); setBusy(null); }
  };
  const disabled = Boolean(busy) || mic.busy;
  return <section style={{ width: '100%', maxWidth: 640 }}>
    <h1 style={{ marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, fontSize: 28, fontWeight: 300 }}>Voice &amp; permissions</h1>
    <p style={{ fontSize: 13, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>Optional. Enable the features you want; you can start coding without these permissions.</p>
    {returned ? <p role="status" style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>Back where you left off. {checked ? Object.values(statuses).includes('unknown') ? 'Some permissions could not be verified.' : 'Permissions checked.' : 'Checking permissions again.'}</p> : null}
    {!native ? <p role="status" style={{ fontSize: 13 }}>Open the macOS app to check native permissions.</p> : <>
      <div style={{ marginTop: 20, marginBottom: 20 }}>
        {PERMISSIONS.map((item) => <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 16, paddingTop: 12, paddingBottom: 12, borderBottom: '1px solid var(--t-divider)' }}>
          <div style={{ flex: 1 }}><div style={{ fontSize: 13.5, fontWeight: 300 }}>{item.label}</div><div style={{ marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>{reasons[item.id]}</div></div>
          {statuses[item.id] === 'granted' ? <span role="status" aria-label={`${item.label} ready`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0, minHeight: 32, paddingTop: 4, paddingBottom: 4, paddingLeft: 11, paddingRight: 12, borderRadius: 20, border: '1px solid var(--t-success-border)', background: 'var(--t-success-soft)', color: 'var(--t-success)', fontSize: 11, fontWeight: 400 }}><ReadyMark />Ready</span> : <span style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{statuses[item.id] === 'unknown' ? 'Not verified' : 'Not enabled'}</span>}
          {statuses[item.id] !== 'granted' ? <button type="button" disabled={disabled} aria-label={`Enable ${item.label}`} onClick={() => void fix(item.id)} style={onboardingQuietButtonStyle}>{busy === item.id ? 'Opening…' : 'Enable'}</button> : null}
        </div>)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <button type="button" disabled={Boolean(busy)} onClick={() => mic.busy ? mic.stop() : void mic.start()} style={onboardingQuietButtonStyle}>{mic.busy ? 'Stop microphone test' : 'Test microphone'}</button>
        <div role="meter" aria-label="Microphone input" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(mic.level * 100)} style={{ height: 4, flex: 1, borderRadius: 2, background: 'var(--t-divider)' }}><div style={{ width: `${mic.level * 100}%`, height: '100%', background: 'var(--t-text-secondary)', borderRadius: 2 }} /></div>
      </div>
      {mic.state === 'heard' ? <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, paddingTop: 14, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, borderRadius: 12, border: '1px solid var(--t-success-border)', background: 'var(--t-success-soft)', color: 'var(--t-success)' }}><ReadyMark size={24} /><div><div style={{ fontSize: 14, fontWeight: 400 }}>We can hear you.</div><div style={{ marginTop: 3, fontSize: 12, color: 'var(--t-text-secondary)' }}>Your microphone picked up audio. You’re ready to try voice.</div></div></div> : <p role="status" style={{ minHeight: 20, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{mic.state === 'starting' ? 'Waiting for microphone access…' : mic.state === 'listening' ? 'Say a few words. Checking audio for eight seconds…' : mic.state === 'silent' ? 'No audio detected. Check the selected microphone and input volume, then try again.' : mic.state === 'interrupted' ? 'Test stopped when you left the app. Try again when you’re ready.' : 'Try a quick microphone check before your first conversation.'}</p>}
      <p style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Audio levels stay on this device. This test does not save audio or check transcription.</p>
      {restartSuggested ? <p style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>A permission changed. Restart o8 to apply it, then check again.</p> : null}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
        <button type="button" disabled={disabled} onClick={restartSuggested ? () => void restart() : onContinue} style={{ ...onboardingButtonStyle, background: 'var(--t-text)', color: 'var(--t-onboarding-bg)' }}>{busy === 'restart' ? 'Restarting…' : restartSuggested ? 'Restart and return' : 'Back to projects'}</button>
        <button type="button" disabled={disabled} onClick={restartSuggested ? onContinue : () => void restart()} style={onboardingQuietButtonStyle}>{restartSuggested ? 'Do this later' : 'Restart and return'}</button>
      </div>
    </>}
    {error || mic.error ? <p role="alert" style={{ fontSize: 12, color: 'var(--t-danger)' }}>{error || mic.error}</p> : null}
  </section>;
}
