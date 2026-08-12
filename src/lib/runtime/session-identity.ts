import { getRuntime } from '@/lib/runtimes';

const SAFE_IDENTITY_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

export async function resolveRuntimeSessionIdentityId(
  runtimeId: string,
  sessionKey: string | null | undefined,
): Promise<string | null> {
  const normalizedSessionKey = sessionKey?.trim() ?? '';
  if (!normalizedSessionKey) return null;
  const runtime = getRuntime(runtimeId);
  if (!runtime?.getSessionIdentityId) return null;
  try {
    const identityId = (await runtime.getSessionIdentityId(normalizedSessionKey))?.trim() ?? '';
    return SAFE_IDENTITY_ID.test(identityId) ? identityId : null;
  } catch {
    return null;
  }
}
