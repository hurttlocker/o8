import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PiSdkScript = 'worker.mjs' | 'approved-write.mjs';

const SOURCE: Record<PiSdkScript, () => URL> = {
  'worker.mjs': () => new URL('../../../../scripts/pi-sdk/worker.mjs', import.meta.url),
  'approved-write.mjs': () => new URL('../../../../scripts/pi-sdk/approved-write.mjs', import.meta.url),
};

/**
 * The packaged server runs from Resources/server, where the desktop export puts
 * the bundled worker in pi-sdk/ (#3255). Source checkouts run the scripts in place.
 */
export function piSdkScriptPath(name: PiSdkScript, env: Record<string, string | undefined> = process.env): string {
  const file = env.O8_PACKAGED_APP === '1'
    ? join(env.O8_PI_SDK_DIR || join(process.cwd(), 'pi-sdk'), name)
    : fileURLToPath(SOURCE[name]());
  if (!existsSync(file)) throw new Error(`Pi SDK ${name} is missing from this build`);
  return file;
}
