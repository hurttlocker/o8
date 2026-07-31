import type {
  MobileOrchestratorBackend,
  MobileOrchestratorThread,
} from '@/lib/mobile/types';

export interface MobileOrchestratorRoute {
  repoPath: string;
  threadId: string;
  projectId: string | null;
  backend: MobileOrchestratorBackend | null;
  agent: string | null;
}

type MobileOrchestratorWireMessage = Record<string, string | number>;

export function mobileOrchestratorRouteFromThread(
  thread: MobileOrchestratorThread | null,
): MobileOrchestratorRoute | null {
  const repoPath = thread?.repoPath?.trim() ?? '';
  const threadId = thread?.id?.trim() ?? '';
  if (!repoPath || !threadId) return null;
  return {
    repoPath,
    threadId,
    projectId: thread?.projectId?.trim() || null,
    backend: thread?.backend ?? null,
    agent: thread?.agent?.trim() || null,
  };
}

export function mobileOrchestratorRouteKey(route: MobileOrchestratorRoute | null): string | null {
  if (!route) return null;
  return [
    route.repoPath,
    route.threadId,
    route.projectId ?? '',
    route.backend ?? '',
    route.agent ?? '',
  ].join('\u001f');
}

function routeFields(route: MobileOrchestratorRoute): MobileOrchestratorWireMessage {
  return {
    repoPath: route.repoPath,
    threadId: route.threadId,
    ...(route.backend ? { backend: route.backend } : {}),
    ...(route.agent ? { agent: route.agent } : {}),
  };
}

export function buildMobileOrchestratorSubscribe(
  route: MobileOrchestratorRoute,
  since: number,
): MobileOrchestratorWireMessage {
  return {
    type: 'orchestrator-subscribe',
    ...routeFields(route),
    since,
  };
}

export function buildMobileOrchestratorStatus(
  route: MobileOrchestratorRoute,
): MobileOrchestratorWireMessage {
  return {
    type: 'orchestrator-status',
    ...routeFields(route),
  };
}

export function buildMobileOrchestratorUnsubscribe(
  route: MobileOrchestratorRoute,
): MobileOrchestratorWireMessage {
  return {
    type: 'orchestrator-unsubscribe',
    ...routeFields(route),
  };
}

export function buildMobileOrchestratorSend(
  route: MobileOrchestratorRoute,
  message: string,
  clientMutationId?: string | null,
): MobileOrchestratorWireMessage {
  return {
    type: 'orchestrator-send',
    ...routeFields(route),
    ...(route.projectId ? { projectId: route.projectId } : {}),
    message,
    permissionMode: 'full',
    ...(clientMutationId ? { clientMutationId } : {}),
  };
}

export function buildMobileOrchestratorInterrupt(
  route: MobileOrchestratorRoute,
): MobileOrchestratorWireMessage {
  return {
    type: 'orchestrator-interrupt',
    ...routeFields(route),
  };
}
