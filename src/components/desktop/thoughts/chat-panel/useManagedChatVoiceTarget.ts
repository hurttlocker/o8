'use client';
import { useEffect, useRef, type RefObject } from 'react';
import { canUseTauriEvents, isTauri } from '@/lib/tauri/bridge';
import { subscribeTauriEvent } from '@/lib/tauri/events';
import { managedChatVoiceTargets, type ManagedChatVoiceTarget } from '@/lib/voice/managed-live/chat-targets';
import type { LiveState } from '@/lib/voice/managed-live/session';

let listeners = 0;
let dispose: (() => void) | undefined;
function listenForVoiceShortcut(): () => void {
  if (listeners++ === 0) {
    const toggle = () => { void managedChatVoiceTargets.hotkey(document.hasFocus()); };
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== 'CapsLock' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      toggle();
    };
    if (canUseTauriEvents()) dispose = subscribeTauriEvent('o8:managed-chat-voice-toggle', toggle);
    else if (!isTauri()) { window.addEventListener('keydown', keydown); dispose = () => window.removeEventListener('keydown', keydown); }
  }
  return () => { if (--listeners === 0) { dispose?.(); dispose = undefined; } };
}

export function useManagedChatVoiceTarget(input: {
  available: boolean; root?: RefObject<HTMLDivElement | null>; trigger: RefObject<HTMLButtonElement | null>;
  state: RefObject<LiveState>; toggle: () => Promise<void>;
}) {
  const current = useRef(input);
  const target = useRef<ManagedChatVoiceTarget | null>(null);
  useEffect(() => { current.current = input; });
  useEffect(() => {
    if (!input.available) return;
    const anchor = input.root?.current ?? input.trigger.current;
    const element = anchor?.closest<HTMLElement>('[data-voice-chat-root]') ?? anchor;
    if (!element) return;
    const registration: ManagedChatVoiceTarget = {
      eligible: () => element.isConnected && !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0,
      state: () => current.current.state.current,
      toggle: () => current.current.toggle(),
    };
    target.current = registration;
    const unregister = managedChatVoiceTargets.register(registration);
    const releaseShortcut = listenForVoiceShortcut();
    const focus = () => managedChatVoiceTargets.focus(registration);
    element.addEventListener('pointerdown', focus); element.addEventListener('focusin', focus);
    if (element.contains(document.activeElement)) focus();
    return () => { unregister(); releaseShortcut(); element.removeEventListener('pointerdown', focus); element.removeEventListener('focusin', focus); target.current = null; };
  }, [input.available, input.root, input.trigger]);
  return async () => target.current ? managedChatVoiceTargets.request(target.current) : false;
}
