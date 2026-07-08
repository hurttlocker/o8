import 'server-only';

import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { isSingleSubCheapTierWorker } from '@/lib/operator/subscription-profile';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export function resolvePacketAdvisorEnabled(packet: Pick<OrchestratorPacket, 'runtime' | 'assignedModel' | 'workerRouting'>): boolean {
  return isSingleSubCheapTierWorker({
    profile: getOperatorDefaultsSync().values.subscriptionProfile,
    runtime: packet.workerRouting?.selectedRuntime ?? packet.runtime,
    model: packet.workerRouting?.selectedModel ?? packet.assignedModel ?? null,
  });
}

export const ADVISOR_PROMPT_SECTION = [
  'Advisor discipline (single-sub cheap-tier worker): before any substantive work, do the huddle turn first.',
  'Your huddle report must state your plan, assumptions, and any pushback if the requested path looks risky, underspecified, or worse than a simpler alternative.',
  'After the orchestrator steers you to proceed, continue normally. If you later hit a decision you cannot resolve confidently, prefer `o8 ask` over guessing or burning time rediscovering repo history.',
].join(' ');
