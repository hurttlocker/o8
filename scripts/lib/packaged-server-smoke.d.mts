export function smokePackagedServer(
  serverRoot: string,
  options?: { timeoutMs?: number; supervised?: boolean },
): Promise<{ port: number; version: string }>;
