// Fault injection is confined to this test process; production has no crash hook.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const original = childProcess.execFileSync;
let created = false;
childProcess.execFileSync = ((file: string, args: string[], options: unknown) => {
  const owned = args?.includes(process.env.O8_DASH_TMUX_SERVER_NAME ?? '__none__');
  const spawning = owned && args.includes('new-session');
  const fault = process.env.O8_TEST_TERMINAL_FAULT;
  if (spawning && fault === 'before-spawn') process.kill(process.pid, 'SIGKILL');
  if (owned && created && args.includes('display-message') && fault === 'inspection') throw new Error('Injected inspection failure');
  const result = original(file, args, options as childProcess.ExecFileSyncOptions);
  if (spawning) {
    created = true;
    if (fault === 'after-spawn') process.kill(process.pid, 'SIGKILL');
  }
  return result;
}) as typeof childProcess.execFileSync;
syncBuiltinESMExports();
void import('./action-plugin-state-host');
