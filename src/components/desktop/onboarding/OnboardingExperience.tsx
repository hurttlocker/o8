'use client';

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { browserProgressStorage, type ProgressStorage } from './onboarding-progress';
import { isOnboardingMuted, playOnboardingCue, setOnboardingMuted } from './onboarding-sound';
import { onboardingQuietButtonStyle } from './onboarding-style';

const Interaction = createContext<RefObject<boolean> | null>(null);
const Sound = createContext<{ muted: boolean; toggle: (preview?: boolean) => void; error: string } | null>(null);

export function OnboardingExperience({ children, storage }: { children?: ReactNode; storage?: ProgressStorage | null }) {
  const [soundStorage] = useState(() => storage === undefined ? browserProgressStorage() : storage);
  const pointer = useRef(false);
  const [muted, setMuted] = useState(() => isOnboardingMuted(soundStorage));
  const [error, setError] = useState('');
  const toggle = (preview = true) => {
    if (!setOnboardingMuted(!muted, soundStorage)) { setError('Sound preference could not be saved.'); return; }
    setError(''); setMuted(!muted);
    if (muted && preview) playOnboardingCue('tick', soundStorage);
  };
  return <Interaction.Provider value={pointer}><Sound.Provider value={{ muted, toggle, error }}>
    <div style={{ display: 'contents' }} onPointerDownCapture={() => { pointer.current = true; }} onKeyDownCapture={() => { pointer.current = false; }} onClickCapture={(event) => {
      if (muted || !event.detail || !(event.target instanceof Element)) return;
      const control = event.target.closest('button, a');
      if (!control || control.matches(':disabled') || control.closest('[data-onboarding-sound="silent"]')) return;
      playOnboardingCue(control.getAttribute('data-onboarding-cue') === 'advance' ? 'advance' : 'tick', soundStorage);
    }}>{children}</div>
  </Sound.Provider></Interaction.Provider>;
}

/** Step and disclosure changes only. Controls remain interactive throughout. */
export function useOnboardingMotion(key: string) {
  const pointer = useContext(Interaction);
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(key);
  useLayoutEffect(() => {
    const changed = previous.current !== key;
    previous.current = key;
    if (!changed) return;
    if (!pointer?.current || typeof window.matchMedia !== 'function' || !ref.current?.animate) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) return;
    const animation = ref.current.animate([
      { opacity: 0.65, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    const cancel = () => animation.cancel();
    preference.addEventListener('change', cancel);
    return () => { cancel(); preference.removeEventListener('change', cancel); };
  }, [key, pointer]);
  return ref;
}

export function OnboardingSoundToggle({ quiet = false }: { quiet?: boolean }) {
  const sound = useContext(Sound);
  if (!sound) return null;
  return <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }} data-onboarding-sound="silent">
    <button type="button" aria-label="Onboarding sounds" aria-pressed={!sound.muted} onClick={() => sound.toggle(!quiet)} style={{ ...onboardingQuietButtonStyle, fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <svg aria-hidden width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z" />{sound.muted ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />}</svg>
      Sounds {sound.muted ? 'off' : 'on'}
    </button>
    {sound.error ? <span role="status" style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{sound.error}</span> : null}
  </div>;
}
