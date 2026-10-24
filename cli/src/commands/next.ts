import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { CliError, EXIT } from '../api.js';

/** Explicit binary + origin; this command never resolves installed-app config. */
export async function runNext(args: string[]): Promise<number> {
  if (args.includes('--help')) {
    process.stdout.write('o8 next --enable-next --binary /absolute/path/o8-next --server http://127.0.0.1:PORT [--offscreen]\nSaved sessions and composer; build native/o8-next separately. Set O8_NEXT_API_TOKEN for the selected server.\n');
    return 0;
  }
  const at = args.indexOf('--binary');
  const binary = at >= 0 ? args[at + 1] : undefined;
  if (!args.includes('--enable-next') || !binary || !isAbsolute(binary) || !args.includes('--server')) {
    throw new CliError('invalid_args', 'Pass --enable-next, --binary with an absolute executable path, and --server.', EXIT.INVALID_ARGS);
  }
  const forwarded = [...args.slice(0, at), ...args.slice(at + 2)];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, forwarded, { stdio: 'inherit', shell: false });
    const forward = () => { child.kill('SIGTERM'); };
    process.once('SIGTERM', forward); process.once('SIGINT', forward);
    const remove = () => { process.off('SIGTERM', forward); process.off('SIGINT', forward); };
    child.once('error', () => { remove(); reject(new CliError('native_unavailable', 'Could not launch the selected native binary.', EXIT.INVALID_ARGS)); });
    child.once('exit', code => { remove(); resolve(code ?? 1); });
  });
}
