import { createHash } from 'node:crypto';

import type { PacketTaskContract } from '@/lib/orchestrator/types';

function canonicalContract(contract: PacketTaskContract): string {
  return JSON.stringify({
    version: contract.version,
    requirements: contract.requirements.map((requirement) => ({
      id: requirement.id,
      source: requirement.source,
      expectedBehavior: requirement.expectedBehavior,
      productionPath: requirement.productionPath,
      verification: requirement.verification,
    })),
    smallestRoute: contract.smallestRoute.map((route) => ({
      path: route.path,
      requirements: route.requirements,
      reason: route.reason,
    })),
    exclusions: contract.exclusions,
  });
}

export function fingerprintQualitySearchContract(contract: PacketTaskContract): string {
  return createHash('sha256').update(canonicalContract(contract)).digest('hex');
}
