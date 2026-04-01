'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const FTUX_MILESTONE_STORAGE_KEY = 'cortex-ftux-milestones';

export const FTUX_MILESTONE_IDS = [
  'firstAgentSpawned',
  'firstFileChange',
  'firstApprovalRequested',
  'firstCompletion',
  'firstMobilePrompt',
] as const;

export type FtuxMilestoneId = typeof FTUX_MILESTONE_IDS[number];

export type FtuxMilestoneState = Record<FtuxMilestoneId, { seen: boolean }>;

type FtuxRevealState = Record<FtuxMilestoneId, boolean>;

const FTUX_REVEAL_AUTO_HIDE_MS: Record<FtuxMilestoneId, number> = {
  firstAgentSpawned: 5600,
  firstFileChange: 6200,
  firstApprovalRequested: 6800,
  firstCompletion: 6400,
  firstMobilePrompt: 8200,
};

function buildDefaultMilestones(): FtuxMilestoneState {
  return {
    firstAgentSpawned: { seen: false },
    firstFileChange: { seen: false },
    firstApprovalRequested: { seen: false },
    firstCompletion: { seen: false },
    firstMobilePrompt: { seen: false },
  };
}

function buildDefaultRevealState(): FtuxRevealState {
  return {
    firstAgentSpawned: false,
    firstFileChange: false,
    firstApprovalRequested: false,
    firstCompletion: false,
    firstMobilePrompt: false,
  };
}

function sanitizeMilestones(raw: unknown): FtuxMilestoneState {
  const fallback = buildDefaultMilestones();
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const candidate = raw as Partial<Record<FtuxMilestoneId, { seen?: unknown }>>;
  return FTUX_MILESTONE_IDS.reduce<FtuxMilestoneState>((next, milestoneId) => {
    next[milestoneId] = {
      seen: candidate[milestoneId]?.seen === true,
    };
    return next;
  }, { ...fallback });
}

function readMilestonesFromStorage() {
  if (typeof window === 'undefined') {
    return buildDefaultMilestones();
  }

  try {
    const stored = window.localStorage.getItem(FTUX_MILESTONE_STORAGE_KEY);
    if (!stored) {
      return buildDefaultMilestones();
    }
    return sanitizeMilestones(JSON.parse(stored));
  } catch {
    return buildDefaultMilestones();
  }
}

export function useProgressiveFtuxMilestones() {
  const [milestones, setMilestones] = useState<FtuxMilestoneState>(() => readMilestonesFromStorage());
  const [activeReveals, setActiveReveals] = useState<FtuxRevealState>(() => buildDefaultRevealState());
  const milestonesRef = useRef(milestones);
  const revealTimeoutsRef = useRef<Partial<Record<FtuxMilestoneId, number>>>({});

  useEffect(() => {
    milestonesRef.current = milestones;
  }, [milestones]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(FTUX_MILESTONE_STORAGE_KEY, JSON.stringify(milestones));
    } catch {
      // Ignore storage failures and keep the in-memory FTUX state.
    }
  }, [milestones]);

  useEffect(() => {
    return () => {
      for (const timeoutId of Object.values(revealTimeoutsRef.current)) {
        if (typeof timeoutId === 'number') {
          window.clearTimeout(timeoutId);
        }
      }
    };
  }, []);

  const dismissReveal = useCallback((milestoneId: FtuxMilestoneId) => {
    const timeoutId = revealTimeoutsRef.current[milestoneId];
    if (typeof timeoutId === 'number') {
      window.clearTimeout(timeoutId);
      delete revealTimeoutsRef.current[milestoneId];
    }
    setActiveReveals((current) => (
      current[milestoneId]
        ? { ...current, [milestoneId]: false }
        : current
    ));
  }, []);

  const markSeen = useCallback((milestoneId: FtuxMilestoneId, options?: { showReveal?: boolean }) => {
    const current = milestonesRef.current;
    if (current[milestoneId].seen) {
      return false;
    }

    const next: FtuxMilestoneState = {
      ...current,
      [milestoneId]: { seen: true },
    };
    milestonesRef.current = next;
    setMilestones(next);

    if (options?.showReveal === false) {
      return true;
    }

    const timeoutId = revealTimeoutsRef.current[milestoneId];
    if (typeof timeoutId === 'number') {
      window.clearTimeout(timeoutId);
    }

    setActiveReveals((currentState) => ({ ...currentState, [milestoneId]: true }));
    revealTimeoutsRef.current[milestoneId] = window.setTimeout(() => {
      setActiveReveals((currentState) => ({ ...currentState, [milestoneId]: false }));
      delete revealTimeoutsRef.current[milestoneId];
    }, FTUX_REVEAL_AUTO_HIDE_MS[milestoneId]);

    return true;
  }, []);

  const dormant = useMemo(
    () => FTUX_MILESTONE_IDS.every((milestoneId) => milestones[milestoneId].seen),
    [milestones],
  );

  return {
    milestones,
    activeReveals,
    dormant,
    markSeen,
    dismissReveal,
  };
}
