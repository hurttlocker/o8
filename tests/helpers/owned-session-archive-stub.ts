type OwnedSessionLifecycleModule = typeof import('@/lib/runtimes/shared/owned-session-lifecycle');

/**
 * Stub the session-directory archive for one fixture session at the registered
 * owned-session lifecycle, the seam lane session archival dispatches through.
 * Use inside a `vi.mock('@/lib/runtimes/shared/owned-session-lifecycle')`
 * factory; every other session and lifecycle method stays real. `onArchive`
 * may return false to leave the archive unconfirmed.
 */
export function stubFixtureSessionArchive(
  actual: OwnedSessionLifecycleModule,
  fixture: { sessionKey: string },
  onArchive: () => Promise<boolean | void> | boolean | void = () => {},
): OwnedSessionLifecycleModule {
  return {
    ...actual,
    getOwnedSessionLifecycle: (surfaceId: string) => {
      const lifecycle = actual.getOwnedSessionLifecycle(surfaceId);
      if (!lifecycle || surfaceId !== fixture.sessionKey) return lifecycle;
      return {
        ...lifecycle,
        archiveSession: async () => {
          const archived = (await onArchive()) !== false;
          return { archived, note: archived ? 'Fixture session archived.' : 'Fixture session archive refused.' };
        },
      };
    },
  };
}
