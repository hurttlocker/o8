export function smokePackagedServer(
  serverRoot: string,
  options?: { timeoutMs?: number },
): Promise<{ port: number; version: string }>;
