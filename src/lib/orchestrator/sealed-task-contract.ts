import { normalizePacketTaskContract } from './packet-task-contract';
import type { PacketTaskContract } from './types';

const text = { type: 'string', minLength: 1, maxLength: 480 } as const;
const id = { type: 'string', minLength: 1, maxLength: 32 } as const;
export const PACKET_TASK_CONTRACT_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    version: { type: 'number', enum: [1] },
    requirements: { type: 'array', minItems: 1, maxItems: 24, items: {
      type: 'object', additionalProperties: false,
      properties: { id, source: text, expectedBehavior: text, productionPath: text, verification: text },
      required: ['id', 'source', 'expectedBehavior', 'productionPath', 'verification'],
    } },
    smallestRoute: { type: 'array', minItems: 1, maxItems: 24, items: {
      type: 'object', additionalProperties: false,
      properties: { path: text, requirements: { type: 'array', minItems: 1, maxItems: 24, items: id }, reason: text },
      required: ['path', 'requirements', 'reason'],
    } },
    processConstraints: { type: 'array', minItems: 1, maxItems: 24, items: {
      type: 'object', additionalProperties: false,
      properties: { id, source: text, expectedBehavior: text, verification: text },
      required: ['id', 'source', 'expectedBehavior', 'verification'],
    } },
    exclusions: { type: 'array', maxItems: 12, items: text },
  },
  required: ['version', 'requirements', 'smallestRoute', 'exclusions'],
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** A seal must already be canonical: never truncate, drop or rewrite its scope. */
export function parseSealedTaskContract(value: unknown): PacketTaskContract {
  const normalized = normalizePacketTaskContract(value);
  if (!normalized || canonical(value) !== canonical(normalized)) {
    throw new Error('sealedTaskContract must be a complete canonical version 1 contract: uppercase unique IDs, non-empty normalized text, bounded arrays, and only mapped requirement IDs.');
  }
  return normalized;
}

export function resolveSealedMissionContract(input: {
  sealedTaskContract?: unknown;
  taskContract?: unknown;
  qualitySearch?: unknown;
  comparisonModels?: unknown;
  huddle?: unknown;
}, singleInlineTask: boolean): PacketTaskContract | undefined {
  if (input.sealedTaskContract === undefined) return undefined;
  const contract = parseSealedTaskContract(input.sealedTaskContract);
  if (!singleInlineTask) throw new Error('sealedTaskContract requires exactly one inline task.');
  if (input.taskContract !== undefined || input.qualitySearch !== undefined
    || input.comparisonModels !== undefined || input.huddle === true) {
    throw new Error('sealedTaskContract cannot be combined with taskContract, qualitySearch, comparisonModels or huddle mode.');
  }
  return contract;
}

export const SEALED_TASK_CONTRACT_INPUT_SCHEMA = {
  ...PACKET_TASK_CONTRACT_INPUT_SCHEMA,
  description: 'One explicit sealed contract for exactly one inline task and one packet, without candidate comparison. Supply canonical uppercase IDs and normalized text; malformed or lossy contracts are refused. Cannot be combined with taskContract, qualitySearch, comparisonModels or huddle.',
} as const;
