import type { CommandCenterSnapshot } from '@/lib/command-center/snapshot';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';

export type RenderBootstrapSource = 'hot-broker' | 'degraded' | 'shell-only';
export type RenderBootstrapState = 'live' | 'warming' | 'stale' | 'degraded';

export interface BootstrapEnvelope<T> {
  snapshot: T;
  source: RenderBootstrapSource;
  state: RenderBootstrapState;
}

function isLiveCommandCenter(snapshot: CommandCenterSnapshot) {
  return snapshot.fleet.meta.mode === 'live';
}

function hasMeaningfulCommandCenterTruth(snapshot: CommandCenterSnapshot) {
  return isLiveCommandCenter(snapshot)
    || snapshot.fleet.agents.length > 0
    || snapshot.review !== null
    || snapshot.browserInventory.surfaces.length > 0
    || snapshot.attachedBrowser !== null;
}

export function shouldRetainCurrentCommandCenterSnapshot(
  current: CommandCenterSnapshot,
  incoming: BootstrapEnvelope<CommandCenterSnapshot>,
) {
  if (!hasMeaningfulCommandCenterTruth(current)) return false;

  if (incoming.source === 'shell-only') return true;
  if (isLiveCommandCenter(current) && (incoming.state !== 'live' || incoming.snapshot.fleet.meta.mode !== 'live')) return true;
  if (current.review && !incoming.snapshot.review) return true;
  if (current.attachedBrowser && !incoming.snapshot.attachedBrowser) return true;
  if (
    current.browserInventory.surfaces.length > 0
    && incoming.snapshot.browserInventory.surfaces.length === 0
    && incoming.source !== 'hot-broker'
  ) {
    return true;
  }

  return false;
}

function hasMeaningfulMobileTruth(snapshot: MobileInboxSnapshot) {
  return snapshot.mode === 'live'
    || snapshot.sessions.length > 0
    || snapshot.items.length > 0
    || Boolean(snapshot.review)
    || Boolean(snapshot.primarySessionKey);
}

export function shouldRetainCurrentMobileSnapshot(
  current: MobileInboxSnapshot,
  incoming: BootstrapEnvelope<MobileInboxSnapshot>,
) {
  if (!hasMeaningfulMobileTruth(current)) return false;

  if (incoming.source === 'shell-only') return true;
  if (current.mode === 'live' && (incoming.state !== 'live' || incoming.snapshot.mode !== 'live')) return true;
  if (current.review && !incoming.snapshot.review) return true;
  if (current.primarySessionKey && !incoming.snapshot.primarySessionKey && incoming.source !== 'hot-broker') return true;
  if (current.items.length > 0 && incoming.snapshot.items.length === 0 && incoming.source !== 'hot-broker') return true;
  if (current.sessions.length > 0 && incoming.snapshot.sessions.length === 0 && incoming.source !== 'hot-broker') return true;

  return false;
}
