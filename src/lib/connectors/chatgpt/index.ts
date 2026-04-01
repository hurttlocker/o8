/**
 * ChatGPT Connector — public API.
 *
 * Usage:
 *   import { parseConversationsJson, extractProfileHeuristic } from '@/lib/connectors/chatgpt';
 */

export {
  extractConversationsFromZip,
  parseConversationsJson,
  computeParseStats,
  type ParseStats,
} from './parser';

export {
  extractProfileHeuristic,
  buildLLMEnrichmentPrompt,
} from './profile';

export type {
  ChatGPTExportConversation,
  ParsedConversation,
  ParsedMessage,
  ExtractedProfile,
  UserTopic,
  UserSkillAssessment,
  UserProject,
  UnfinishedThread,
  UserCommunicationStyle,
  ImportProgress,
} from './types';
