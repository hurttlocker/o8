export type {
  ApproveAndMergeInput,
  CreateMissionInput,
  DispatchMissionInput,
  ExistingBranchPolicy,
  LoadedIssue,
  MergePacketResult,
  MissionStatusInput,
  PickComparisonWinnerInput,
  ResetPacketInput,
  SubmitReviewInput,
} from './operator-mission-service/types';

export {
  createMission,
  dispatchMission,
  getMissionStatus,
  MissionNotFoundError,
  resolveMissionDispatchTarget,
} from './operator-mission-service/mission';

export { submitPacketReview } from './operator-mission-service/review';

export {
  approveAndMergePacket,
  pickComparisonWinner,
} from './operator-mission-service/merge';

export { resetPacket } from './operator-mission-service/reset';

export { rerunWithFeedback } from './operator-mission-service/rerun-with-feedback';
export type { RerunWithFeedbackInput } from './operator-mission-service/rerun-with-feedback';

export { steerPacket } from './operator-mission-service/steer';
export type { SteerPacketInput, SteerPacketResult } from './operator-mission-service/steer';

export {
  buildInlineIssuesFromPrompt,
  clampSpawnCount,
  SPAWN_PROMPT_MAX_AGENTS,
} from './operator-mission-service/spawn-prompt';
