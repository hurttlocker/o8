'use client';

import { useCallback, useMemo, useState } from 'react';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

export type AmbientMode = 'stream' | 'diff' | 'pulse' | 'issue' | 'pr';

export interface AmbientSelectedFile {
  repoPath: string;
  filePath: string;
}

export interface AmbientLinkedRef {
  id: number | string;
  repo?: string | null;
}

export interface AmbientModeState {
  missionState?: Pick<OrchestratorMissionState, 'packets'> | null;
  focusedRepoPath?: string | null;
  selectedFile?: AmbientSelectedFile | null;
  selectedIssue?: AmbientLinkedRef | null;
  selectedPR?: AmbientLinkedRef | null;
}

const LOCK_STORAGE_KEY = 'cortex-ide:right-panel:locked-mode';
const MODES: AmbientMode[] = ['stream', 'diff', 'pulse', 'issue', 'pr'];

function isAmbientMode(value: string | null): value is AmbientMode {
  return MODES.includes(value as AmbientMode);
}

function pathMatchesFocus(packetPath: string | null | undefined, focusedRepoPath: string | null | undefined): boolean {
  if (!focusedRepoPath) return true;
  if (!packetPath) return false;
  return packetPath === focusedRepoPath
    || packetPath.startsWith(`${focusedRepoPath}/`)
    || focusedRepoPath.startsWith(`${packetPath}/`);
}

export function pickAmbientMode(state: AmbientModeState): AmbientMode {
  const packets = state.missionState?.packets ?? [];
  const hasRunningPacket = packets.some((packet) => (
    packet.status === 'running' && pathMatchesFocus(packet.workspaceTargetPath, state.focusedRepoPath)
  ));
  if (hasRunningPacket) return 'stream';
  if (state.selectedFile) return 'diff';
  if (state.selectedIssue) return 'issue';
  if (state.selectedPR) return 'pr';
  return 'pulse';
}

export function findAmbientRunningPacket(
  packets: OrchestratorPacket[],
  focusedRepoPath: string | null | undefined,
  preferredPacketId?: string | null,
): OrchestratorPacket | null {
  const focusedPackets = packets.filter((packet) => (
    packet.status === 'running' && pathMatchesFocus(packet.workspaceTargetPath, focusedRepoPath)
  ));
  return focusedPackets.find((packet) => packet.id === preferredPacketId) ?? focusedPackets[0] ?? null;
}

export function useAmbientMode(state: AmbientModeState) {
  const [lockedMode, setLockedMode] = useState<AmbientMode | null>(() => {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage.getItem(LOCK_STORAGE_KEY);
    return isAmbientMode(stored) ? stored : null;
  });

  const autoMode = useMemo(() => pickAmbientMode(state), [state]);
  const mode = lockedMode ?? autoMode;

  const toggleLock = useCallback(() => {
    setLockedMode((current) => {
      const next = current ? null : mode;
      if (typeof window !== 'undefined') {
        if (next) window.localStorage.setItem(LOCK_STORAGE_KEY, next);
        else window.localStorage.removeItem(LOCK_STORAGE_KEY);
      }
      return next;
    });
  }, [mode]);

  return { mode, autoMode, lockedMode, locked: lockedMode !== null, toggleLock };
}
