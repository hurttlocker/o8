import type { OwnedArchiveResponse, OwnedSessionStore } from './owned-session/types';
import type { OwnedSessionState } from './owned-session/types';

export interface OwnedSessionLifecycleRegistration {
  runtimeId: string;
  surfaceIdPrefix: string;
  commandLabel: string;
  resolveRoot(): string;
  sessionState(surfaceId: string): Promise<OwnedSessionState>;
  archiveSession(surfaceId: string): Promise<OwnedArchiveResponse>;
}

const registrations = new Map<string, OwnedSessionLifecycleRegistration>();

export function registerOwnedSessionLifecycleHandler(
  registration: OwnedSessionLifecycleRegistration,
): OwnedSessionLifecycleRegistration {
  registrations.set(registration.surfaceIdPrefix, registration);
  return registration;
}

export function registerOwnedSessionLifecycle(options: {
  runtimeId: string;
  surfaceIdPrefix: string;
  commandLabel: string;
  rootEnvVar: string;
  rootDefault: string;
  store: OwnedSessionStore;
}): OwnedSessionLifecycleRegistration {
  const registration: OwnedSessionLifecycleRegistration = {
    runtimeId: options.runtimeId,
    surfaceIdPrefix: options.surfaceIdPrefix,
    commandLabel: options.commandLabel,
    resolveRoot: () => process.env[options.rootEnvVar] || options.rootDefault,
    sessionState: (surfaceId) => options.store.sessionState(surfaceId),
    archiveSession: (surfaceId) => options.store.archiveSession(surfaceId),
  };
  return registerOwnedSessionLifecycleHandler(registration);
}

export function getOwnedSessionLifecycle(
  surfaceId: string,
): OwnedSessionLifecycleRegistration | undefined {
  return [...registrations.values()]
    .find((registration) => surfaceId.startsWith(registration.surfaceIdPrefix));
}

export function listOwnedSessionLifecycles(): OwnedSessionLifecycleRegistration[] {
  return [...registrations.values()];
}
