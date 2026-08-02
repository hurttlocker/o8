import fs from 'node:fs';
import path from 'node:path';

import type { PacketTaskContract } from '../../src/lib/orchestrator/types';
import {
  PACKET_TASK_CONTRACT_TAG_END,
  PACKET_TASK_CONTRACT_TAG_START,
  parsePacketTaskContract,
} from '../../src/lib/orchestrator/packet-task-contract';

export const CODING_TASK_CONTRACT_FILE = 'task-contract.json';

export function readCodingTaskContract(worktree: string): PacketTaskContract | null {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(worktree, CODING_TASK_CONTRACT_FILE), 'utf8');
  } catch {
    return null;
  }

  const contract = parsePacketTaskContract(
    `${PACKET_TASK_CONTRACT_TAG_START}${contents}${PACKET_TASK_CONTRACT_TAG_END}`,
  );
  if (!contract || contract.requirements.length === 0) return null;

  const mappedRequirements = new Set(contract.smallestRoute.flatMap((route) => route.requirements));
  return contract.requirements.every((requirement) => mappedRequirements.has(requirement.id))
    ? contract
    : null;
}
