import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { writeTimelineVisible } from '@/lib/appearance/timeline';
import {
  areAllFtuxMilestonesSeen,
  readFtuxMilestones,
  writeFtuxMilestones,
  type FtuxMilestoneId,
  type FtuxMilestonesState,
} from '@/lib/ftux/milestones';
import { FTUX_AGENT_PANEL_TARGET_WIDTH, FTUX_REVEAL_DURATION_MS } from '../ftux';
import type { FtuxFirstChangedFile } from '../types';

interface UseFtuxMilestonesArgs {
  sidebarVisible: boolean;
  setLeftWidth: Dispatch<SetStateAction<number>>;
  setSidebarVisible: Dispatch<SetStateAction<boolean>>;
  setTimelineVisible: Dispatch<SetStateAction<boolean>>;
  timelineVisible: boolean;
}

export function useFtuxMilestones({
  sidebarVisible,
  setLeftWidth,
  setSidebarVisible,
  setTimelineVisible,
  timelineVisible,
}: UseFtuxMilestonesArgs) {
  const [ftuxMilestones, setFtuxMilestones] = useState<FtuxMilestonesState>(() => readFtuxMilestones());
  const [ftuxQueuedMilestones, setFtuxQueuedMilestones] = useState<FtuxMilestoneId[]>([]);
  const [activeFtuxMilestone, setActiveFtuxMilestone] = useState<FtuxMilestoneId | null>(null);
  const [ftuxFirstChangedFile, setFtuxFirstChangedFile] = useState<FtuxFirstChangedFile | null>(null);
  const ftuxMilestonesRef = useRef<FtuxMilestonesState>(ftuxMilestones);
  const activeFtuxMilestoneRef = useRef<FtuxMilestoneId | null>(null);
  const ftuxDormant = useMemo(() => areAllFtuxMilestonesSeen(ftuxMilestones), [ftuxMilestones]);

  useEffect(() => {
    ftuxMilestonesRef.current = ftuxMilestones;
  }, [ftuxMilestones]);

  useEffect(() => {
    activeFtuxMilestoneRef.current = activeFtuxMilestone;
  }, [activeFtuxMilestone]);

  const enqueueFtuxMilestone = useCallback((milestoneId: FtuxMilestoneId) => {
    if (ftuxMilestonesRef.current[milestoneId].seen) {
      return false;
    }

    const next = {
      ...ftuxMilestonesRef.current,
      [milestoneId]: { seen: true },
    };

    ftuxMilestonesRef.current = next;
    setFtuxMilestones(next);
    writeFtuxMilestones(next);
    setFtuxQueuedMilestones((current) => (
      current.includes(milestoneId) || activeFtuxMilestoneRef.current === milestoneId
        ? current
        : [...current, milestoneId]
    ));
    return true;
  }, []);

  const dismissFtuxMilestone = useCallback(() => {
    setActiveFtuxMilestone(null);
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- preserve the existing queued milestone handoff without changing behavior */
  useEffect(() => {
    if (activeFtuxMilestone || ftuxQueuedMilestones.length === 0) {
      return;
    }

    const [nextMilestone, ...remaining] = ftuxQueuedMilestones;
    setFtuxQueuedMilestones(remaining);
    setActiveFtuxMilestone(nextMilestone);
  }, [activeFtuxMilestone, ftuxQueuedMilestones]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!activeFtuxMilestone) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setActiveFtuxMilestone((current) => (current === activeFtuxMilestone ? null : current));
    }, FTUX_REVEAL_DURATION_MS);

    return () => window.clearTimeout(timeout);
  }, [activeFtuxMilestone]);

  useEffect(() => {
    if (activeFtuxMilestone !== 'firstAgentSpawned') {
      return;
    }

    if (!sidebarVisible) {
      setSidebarVisible(true);
    }
    setLeftWidth((current) => Math.max(current, FTUX_AGENT_PANEL_TARGET_WIDTH));
  }, [activeFtuxMilestone, setLeftWidth, setSidebarVisible, sidebarVisible]);

  useEffect(() => {
    if (activeFtuxMilestone !== 'firstCompletion') {
      return;
    }

    if (!timelineVisible) {
      writeTimelineVisible(true);
      setTimelineVisible(true);
    }
  }, [activeFtuxMilestone, setTimelineVisible, timelineVisible]);

  return {
    activeFtuxMilestone,
    dismissFtuxMilestone,
    enqueueFtuxMilestone,
    ftuxDormant,
    ftuxFirstChangedFile,
    ftuxMilestones,
    setFtuxFirstChangedFile,
  };
}
