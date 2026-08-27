import { normalizePacketTaskContract } from '@/lib/orchestrator/packet-task-contract';
import type { PacketTaskContract } from '@/lib/orchestrator/types';

export const TASK_CONTRACT_SETTING_SCHEMA = {
  type: 'string',
  enum: ['off'],
  description: 'Mission-level opt-out for the pre-edit task contract. "off" wins over runtime defaults and cannot be combined with quality search.',
} as const;

export function parseTaskContractSetting(value: unknown): 'off' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value !== 'off') throw new Error('taskContract must be "off" when provided.');
  return value;
}

export const QUALITY_SEARCH_INPUT_SCHEMA = {
  type: 'object',
  description: 'Bounded quality search for one task. Two isolated candidates receive different implementation roles from one sealed contract; o8 filters by review and merge evidence before using blast radius as a tie-breaker. Cannot be combined with huddle or comparisonModels.',
  properties: {
    taskContract: {
      type: 'object',
      properties: {
        version: { type: 'number', enum: [1] },
        requirements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              source: { type: 'string' },
              expectedBehavior: { type: 'string' },
              productionPath: { type: 'string' },
              verification: { type: 'string' },
            },
            required: ['id', 'source', 'expectedBehavior', 'productionPath', 'verification'],
          },
        },
        smallestRoute: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              requirements: { type: 'array', items: { type: 'string' } },
              reason: { type: 'string' },
            },
            required: ['path', 'requirements', 'reason'],
          },
        },
        exclusions: { type: 'array', items: { type: 'string' } },
      },
      required: ['version', 'requirements', 'smallestRoute', 'exclusions'],
    },
  },
  required: ['taskContract'],
} as const;

type CandidateMode = {
  ok: true;
  comparisonModels?: string[];
  qualitySearch?: { taskContract: PacketTaskContract };
} | {
  ok: false;
  error: string;
};

export function parseMissionCandidateMode(args: Record<string, unknown>, huddle: boolean | undefined): CandidateMode {
  const comparisonModelsRaw = Array.isArray(args.comparisonModels)
    ? args.comparisonModels.map((model) => String(model).trim()).filter(Boolean).slice(0, 4)
    : [];
  const comparisonModels = comparisonModelsRaw.length > 0 ? comparisonModelsRaw : undefined;
  const qualitySearchRecord = args.qualitySearch && typeof args.qualitySearch === 'object'
    ? args.qualitySearch as Record<string, unknown>
    : null;
  const taskContract = qualitySearchRecord
    ? normalizePacketTaskContract(qualitySearchRecord.taskContract)
    : null;
  if (args.qualitySearch !== undefined && !taskContract) {
    return { ok: false, error: 'qualitySearch.taskContract must be a valid version 1 task contract.' };
  }
  if (taskContract && comparisonModels) {
    return { ok: false, error: 'qualitySearch cannot be combined with comparisonModels.' };
  }
  if (taskContract && huddle) {
    return { ok: false, error: 'qualitySearch already uses a sealed contract and cannot be combined with huddle mode.' };
  }
  if (taskContract && args.taskContract === 'off') {
    return { ok: false, error: 'qualitySearch already uses a sealed contract and cannot be combined with taskContract: "off".' };
  }
  return {
    ok: true,
    comparisonModels,
    qualitySearch: taskContract ? { taskContract } : undefined,
  };
}
