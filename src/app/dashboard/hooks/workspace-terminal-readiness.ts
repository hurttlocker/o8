export async function waitForWorkspaceTerminalHandle<T>(options: {
  read: () => T | null;
  wait: (delayMs: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}): Promise<T | null> {
  const attempts = Math.max(1, options.attempts ?? 120);
  const intervalMs = Math.max(0, options.intervalMs ?? 100);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const handle = options.read();
    if (handle) return handle;
    if (attempt + 1 < attempts) await options.wait(intervalMs);
  }

  return null;
}
