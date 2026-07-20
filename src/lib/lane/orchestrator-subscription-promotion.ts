import type { OrchestratorBackendId } from './orchestrator-backends/types';

export interface OrchestratorSubscriptionRoute {
  clientId: string;
  repoPath: string;
  sessionName: string;
  threadId: string | null;
  backend: OrchestratorBackendId;
  agent: string;
}

export interface ActiveOrchestratorRoute {
  repoPath: string;
  threadId: string | null;
  fromBackend: OrchestratorBackendId;
  toBackend: OrchestratorBackendId;
  toSessionName: string;
}

export interface ActiveOrchestratorRouteHandle {
  key: string;
  token: symbol;
}

/** Tracks temporary backend remaps so reconnecting views resolve the live route. */
export class ActiveOrchestratorRouteRegistry {
  private readonly routes = new Map<string, ActiveOrchestratorRoute & { token: symbol }>();

  private key(input: Pick<ActiveOrchestratorRoute, 'repoPath' | 'threadId' | 'fromBackend'>): string {
    return JSON.stringify([input.repoPath, input.threadId, input.fromBackend]);
  }

  register(route: ActiveOrchestratorRoute): ActiveOrchestratorRouteHandle {
    const key = this.key(route);
    const token = Symbol(key);
    this.routes.set(key, { ...route, token });
    return { key, token };
  }

  resolve(input: {
    repoPath: string;
    threadId: string | null;
    requestedBackend: OrchestratorBackendId;
  }): ActiveOrchestratorRoute | null {
    return this.routes.get(this.key({
      repoPath: input.repoPath,
      threadId: input.threadId,
      fromBackend: input.requestedBackend,
    })) ?? null;
  }

  release(handle: ActiveOrchestratorRouteHandle | null): void {
    if (!handle) return;
    if (this.routes.get(handle.key)?.token === handle.token) this.routes.delete(handle.key);
  }
}

/** Move every existing view on one logical thread to its actual backend route. */
export function promoteOrchestratorSubscribers(
  subscriptions: Map<string, OrchestratorSubscriptionRoute>,
  input: {
    repoPath: string;
    threadId: string | null;
    fromBackend: OrchestratorBackendId;
    toBackend: OrchestratorBackendId;
    toSessionName: string;
  },
): number {
  const toPromote = Array.from(subscriptions.values()).filter((sub) =>
    sub.repoPath === input.repoPath
    && sub.threadId === input.threadId
    && sub.backend === input.fromBackend);

  for (const sub of toPromote) {
    subscriptions.set(`${sub.clientId}::${input.toBackend}::`, {
      clientId: sub.clientId,
      repoPath: sub.repoPath,
      sessionName: input.toSessionName,
      threadId: sub.threadId,
      backend: input.toBackend,
      agent: '',
    });
  }
  return toPromote.length;
}
