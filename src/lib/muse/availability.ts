import { resolveMuseBinary } from './host';
import type { RuntimeAuthStatus } from '@/lib/runtimes/shared/auth-detect';

export async function museAvailability(): Promise<Omit<RuntimeAuthStatus, 'house' | 'runtime' | 'checkedAt'>> {
  try {
    const binaryPath = await resolveMuseBinary();
    return { installed: true, ready: true, authenticated: false, unavailableReason: null, binaryPath,
      detail: 'Muse Code is installed. Account and model access are checked by the CLI when work starts.',
      fix: 'Sign in through Muse Code before starting work.' };
  } catch {
    return { installed: false, ready: false, authenticated: false, unavailableReason: 'not_installed',
      detail: 'Muse Code is not installed.', fix: 'Install Muse Code from https://dev.meta.ai/docs/muse-code, then sign in through the CLI.' };
  }
}
