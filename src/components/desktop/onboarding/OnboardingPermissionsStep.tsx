'use client';

import { useEffect, useRef, useState } from 'react';
import { fixActionLabel, PERMISSIONS, type PermId, type PermStatus } from '@/components/desktop/settings/permissions-model';
import { onboardingActionRowStyle, onboardingButtonStyle, onboardingCardStyle, onboardingQuietButtonStyle } from './onboarding-style';
import { EMPTY_PERMISSIONS, PERMISSIONS_RESUME_KEY, readPermissionsResume, readOnboardingPermissions, requestOnboardingPermission, supportsPermissionCheck, type PermissionSnapshot } from './permissions-check';
import type { ProgressStorage } from './onboarding-progress';
import { useMicrophoneCheck } from './useMicrophoneCheck';
import { OnboardingFeedback, OnboardingReady } from './OnboardingFeedback';
import { SymonMark, SymonPolishMark, SymonWaveform } from '../dictation/SymonVisuals';

const reasons: Record<PermId, string> = {
  microphone: 'Talk to Symon and dictate in o8.',
  accessibility: 'Dictate into another app and use desktop controls.',
  'input-monitoring': 'Use voice shortcuts while another app is focused.',
  'screen-recording': 'Let screen-aware features see your screen when you use them.',
};
export interface OnboardingPermissionClient {
  supported: () => boolean;
  read: () => Promise<PermissionSnapshot>;
  request: (id: PermId, status: PermStatus) => Promise<void>;
}
const nativeClient: OnboardingPermissionClient = { supported: supportsPermissionCheck, read: readOnboardingPermissions, request: requestOnboardingPermission };

export function OnboardingPermissionsStep({ storage, onRestart, onContinue, onBusyChange, client = nativeClient }: {
  storage: ProgressStorage | null; onRestart: () => Promise<void>; onContinue: () => void; onBusyChange: (busy: boolean) => void;
  client?: OnboardingPermissionClient;
}) {
  const native = client.supported();
  const [statuses, setStatuses] = useState<PermissionSnapshot>(EMPTY_PERMISSIONS);
  const previous = useRef<PermissionSnapshot>(EMPTY_PERMISSIONS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [restartSuggested, setRestartSuggested] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [resumeMarker] = useState(() => readPermissionsResume(storage));
  const returned = Boolean(resumeMarker);
  const mic = useMicrophoneCheck();
  useEffect(() => { onBusyChange(Boolean(busy) || mic.busy); return () => onBusyChange(false); }, [busy, mic.busy, onBusyChange]);
  useEffect(() => {
    let cancelled = false;
    let checkedResume = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const next = await client.read().catch(() => ({ ...EMPTY_PERMISSIONS }));
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
  }, [client, native, returned, resumeMarker, storage]);
  const fix = async (id: PermId) => {
    setBusy(id); setError('');
    try { await client.request(id, statuses[id]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open permissions. Try again.'); }
    finally { setBusy(null); }
  };
  const restart = async () => {
    mic.stop(); setBusy('restart'); setError('');
    try { await onRestart(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restart. Your place is saved.'); setBusy(null); }
  };
  const disabled = Boolean(busy) || mic.busy;
  const permissionRow = (id: PermId) => {
    const item = PERMISSIONS.find((permission) => permission.id === id)!;
    const granted = statuses[id] === 'granted';
    return <div key={id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingTop: 12, paddingBottom: 12 }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}><div style={{ fontSize: 13.5, fontWeight: 300 }}>{item.label}</div><div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>{reasons[id]}</div></div>
      {granted ? <OnboardingReady label={`${item.label} ready`} /> : <span role="status" style={{ fontSize: 11, color: 'var(--t-text-secondary)' }}>{!checked ? 'Checking…' : statuses[id] === 'unknown' ? 'Not verified' : 'Not enabled'}</span>}
      {!granted ? <button type="button" disabled={disabled || !checked} aria-label={`Enable ${item.label}`} onClick={() => void fix(id)} style={{ ...onboardingButtonStyle, opacity: disabled || !checked ? 0.5 : 1 }}>{busy === id ? 'Opening…' : fixActionLabel(item, statuses[id])}</button> : null}
    </div>;
  };
  return <section style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 20 }}>
    <div><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><SymonMark size={32} /><h1 style={{ margin: 0, fontSize: 28, fontWeight: 300 }}>Meet Symon.</h1></div>
      <p style={{ marginTop: 12, marginBottom: 0, fontSize: 13, fontWeight: 300, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Your voice layer for o8. Speak a request or dictate text. These permissions are optional; choose the features you want.</p>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 16, fontSize: 11, color: 'var(--t-text-secondary)' }}><SymonWaveform level={0.65} width={88} /><span>Dictate <span aria-hidden>→</span> Transcribe <span aria-hidden>→</span> Polish</span><SymonPolishMark /></div></div>
    {returned ? <p role="status" style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>Back where you left off. {checked ? Object.values(statuses).includes('unknown') ? 'Some permissions could not be verified.' : 'Permissions checked.' : 'Checking permissions again.'}</p> : null}
    {!native ? <div style={onboardingCardStyle}><div style={{ fontSize: 13.5, fontWeight: 300 }}>Voice on your Mac</div><p role="status" style={{ marginTop: 8, marginBottom: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Open the macOS app to check native permissions. You can keep using coding tools here.</p></div> : <>
      <div style={onboardingCardStyle}>
        <div style={{ fontSize: 10, color: 'var(--t-text-muted)', letterSpacing: '0.04em' }}>START WITH YOUR MICROPHONE</div>
        {permissionRow('microphone')}
        <div style={{ borderTop: '1px solid var(--t-divider)', paddingTop: 16 }} data-onboarding-sound="silent">
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
            <button type="button" disabled={Boolean(busy) || !checked || statuses.microphone !== 'granted'} onClick={() => mic.busy ? mic.stop() : void mic.start()} style={{ ...onboardingButtonStyle, opacity: busy || !checked || statuses.microphone !== 'granted' ? 0.5 : 1 }}>{mic.busy ? 'Stop microphone test' : 'Test microphone'}</button>
            <div role="meter" aria-label="Microphone input" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(mic.level * 100)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 150, height: 36, borderRadius: 999, border: '1px solid var(--t-divider)', background: 'var(--t-onboarding-bg)' }}><SymonWaveform level={mic.level} /></div>
          </div>
          {mic.state === 'heard' ? <div style={{ marginTop: 12 }}><OnboardingFeedback title="We can hear you.">Your microphone picked up audio. This confirms input, not transcription or a Symon conversation.</OnboardingFeedback></div> : <p role="status" style={{ minHeight: 20, fontSize: 12, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{mic.state === 'starting' ? 'Waiting for microphone access…' : mic.state === 'listening' ? 'Say a few words. Checking audio for eight seconds…' : mic.state === 'silent' ? 'No audio detected. Check the selected microphone and input volume, then try again.' : mic.state === 'interrupted' ? 'Test stopped when you left the app. Try again when you’re ready.' : statuses.microphone === 'granted' ? 'Try a quick microphone check before your first conversation.' : 'Allow microphone access, then try a quick audio check.'}</p>}
          <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Audio levels stay on this device. This test does not save or send audio.</div>
        </div>
      </div>
      <div style={{ ...onboardingCardStyle, background: 'transparent' }}>
        <button type="button" aria-expanded={controlsOpen} aria-controls="onboarding-desktop-permissions" onClick={() => setControlsOpen((value) => !value)} style={{ ...onboardingQuietButtonStyle, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 0, paddingRight: 0, textAlign: 'left' }}><span>Shortcuts &amp; screen access<span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>Optional access for features beyond this window.</span></span><span aria-hidden>{controlsOpen ? '−' : '+'}</span></button>
        <div id="onboarding-desktop-permissions" hidden={!controlsOpen}>
          {PERMISSIONS.filter((item) => item.id !== 'microphone').map((item) => <div key={item.id} style={{ borderTop: '1px solid var(--t-divider)' }}>{permissionRow(item.id)}</div>)}
          <p style={{ marginBottom: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Once enabled, hold Fn to dictate or right Option to ask Symon. Changed desktop permissions may need a restart.</p>
        </div>
      </div>
    </>}
    {restartSuggested ? <OnboardingFeedback title="Restart to apply the new access">Your project and setup choices are saved before o8 restarts. You return here for another check.</OnboardingFeedback> : null}
    {error || mic.error ? <OnboardingFeedback tone="error" title={error || mic.error}>Your setup is still here. You can retry this check or return to projects.</OnboardingFeedback> : null}
    <div style={onboardingActionRowStyle}>
      {native ? <button type="button" disabled={disabled} onClick={restartSuggested ? onContinue : () => void restart()} style={onboardingQuietButtonStyle}>{restartSuggested ? 'Do this later' : 'Restart and return'}</button> : <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Voice setup is optional.</span>}
      <button type="button" data-onboarding-cue="advance" disabled={disabled} onClick={restartSuggested ? () => void restart() : onContinue} style={{ ...onboardingButtonStyle, background: 'var(--t-text)', color: 'var(--t-onboarding-bg)', opacity: disabled ? 0.5 : 1 }}>{busy === 'restart' ? 'Restarting…' : restartSuggested ? 'Restart and return' : 'Back to projects'}</button>
    </div>
  </section>;
}
