export const FTUX_MILESTONES_STORAGE_KEY = 'cortex-ftux-milestones';

export const FTUX_MILESTONE_IDS = [
  'firstAgentSpawned',
  'firstFileChange',
  'firstApproval',
  'firstCompletion',
  'firstMobilePrompt',
] as const;

export type FtuxMilestoneId = (typeof FTUX_MILESTONE_IDS)[number];

export type FtuxMilestonesState = Record<FtuxMilestoneId, {
  seen: boolean;
}>;

export function createDefaultFtuxMilestones(): FtuxMilestonesState {
  return {
    firstAgentSpawned: { seen: false },
    firstFileChange: { seen: false },
    firstApproval: { seen: false },
    firstCompletion: { seen: false },
    firstMobilePrompt: { seen: false },
  };
}

export function readFtuxMilestones(): FtuxMilestonesState {
  const fallback = createDefaultFtuxMilestones();
  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(FTUX_MILESTONES_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<Record<FtuxMilestoneId, { seen?: boolean }>>;

    return FTUX_MILESTONE_IDS.reduce<FtuxMilestonesState>((state, id) => {
      state[id] = {
        seen: parsed[id]?.seen === true,
      };
      return state;
    }, createDefaultFtuxMilestones());
  } catch {
    return fallback;
  }
}

export function writeFtuxMilestones(state: FtuxMilestonesState) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(FTUX_MILESTONES_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures and keep the in-memory reveal flow alive.
  }
}

export function areAllFtuxMilestonesSeen(state: FtuxMilestonesState) {
  return FTUX_MILESTONE_IDS.every((id) => state[id].seen);
}
