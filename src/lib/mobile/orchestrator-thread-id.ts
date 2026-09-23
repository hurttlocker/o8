export function nextOrchestratorThreadId(
  exists: (threadId: string) => boolean,
  timestamp = Date.now(),
): string {
  let candidate = `thoughts-${timestamp}`;
  let suffix = 0;
  while (exists(candidate)) {
    suffix += 1;
    candidate = `thoughts-${timestamp}-${suffix}`;
  }
  return candidate;
}
