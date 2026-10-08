import type { RuntimeAuthStatus } from './auth-detect';

/**
 * The bundled Pi worker needs no install or sign-in: it runs on o8's own Node
 * and the managed route, which uses the plan token or requests the free
 * allowance token on first use. Readiness is the platform and the shipped files.
 */
export async function piBuiltinReadiness(): Promise<Pick<RuntimeAuthStatus,
  'installed' | 'authenticated' | 'detail' | 'fix' | 'binaryPath'>> {
  const [{ requirePiNode, requirePiPlatform }, { piSdkScriptPath, piWriteHelperPath }] = await Promise.all([
    import('@/lib/pi/sdk/platform'),
    import('@/lib/pi/sdk/scripts'),
  ]);
  try {
    requirePiPlatform();
    requirePiNode();
    piSdkScriptPath('worker.mjs');
    piWriteHelperPath();
  } catch (error) {
    return {
      installed: false,
      authenticated: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: 'Use a supported o8 build on macOS or Linux.',
    };
  }
  return {
    installed: true,
    authenticated: true,
    detail: 'Pi is bundled with o8 and runs on the managed model route: your plan, or the free daily allowance.',
    fix: 'No action needed.',
    binaryPath: process.execPath,
  };
}
