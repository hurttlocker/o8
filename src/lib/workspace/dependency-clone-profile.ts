/** Opt-in diagnostics contain stage names and durations only. */
export async function profileDependencyClone<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await operation(); }
  finally {
    if (process.env.O8_DEPENDENCY_CLONE_PROFILE === '1') {
      console.log('[dependency-clone-profile]', JSON.stringify({ stage, durationMs: Math.round(performance.now() - start) }));
    }
  }
}
