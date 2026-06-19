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
} from './operator-mission-service/mission';

export { submitPacketReview } from './operator-mission-service/review';

export {
  approveAndMergePacket,
  pickComparisonWinner,
} from './operator-mission-service/merge';

export { resetPacket } from './operator-mission-service/reset';

export { rerunWithFeedback } from './operator-mission-service/rerun-with-feedback';
export type { RerunWithFeedbackInput } from './operator-mission-service/rerun-with-feedback';

export {
  buildInlineIssuesFromPrompt,
  clampSpawnCount,
  SPAWN_PROMPT_MAX_AGENTS,
} from './operator-mission-service/spawn-prompt';
