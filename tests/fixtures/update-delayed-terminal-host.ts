// Delay only the fixture's IPC delivery; execute the production terminal child.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createTerminalHostChild } from '../../src/lib/ws-server/terminal-host-child';
import type { TerminalHostRequest } from '../../src/lib/ws-server/terminal-host-protocol';

const child = createTerminalHostChild({
  spawn(spec) {
    const subprocess = spawn(spec.file, spec.args, { cwd: spec.cwd, env: { ...spec.env, NODE_ENV: 'test' } });
    return { pid: subprocess.pid, onData() {}, onExit(callback) { subprocess.on('exit', code => callback({ exitCode: code ?? 1 })); },
      write() {}, resize() {}, kill(signal) { subprocess.kill(signal as NodeJS.Signals); } };
  },
  send: event => { process.send?.(event); },
});
const pending: TerminalHostRequest[] = [];
process.on('message', message => pending.push(message as TerminalHostRequest));
const timer = setInterval(() => {
  if (!existsSync(process.env.O8_LEASE_TEST_GATE!)) return;
  for (const request of pending.splice(0)) child.handle(request);
}, 10);
process.on('disconnect', () => { clearInterval(timer); child.killAll(); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(timer); child.killAll(); process.exit(0); });
