// Local measurement only. Never record command arguments, prompts, or output.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const file = process.env.O8_SPEED_TRACE;
let sequence = 0;
function emit(data) {
  if (file) fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ownerPid: process.pid, ...data }) + '\n', { mode: 0o600 });
}
for (const method of ['spawn', 'execFile', 'spawnSync', 'execFileSync']) {
  const original = cp[method];
  cp[method] = function(command, ...args) {
    const id = `${process.pid}-${++sequence}`;
    const executable = path.basename(String(command));
    let name = executable;
    let argv = Array.isArray(args[0]) ? args[0] : [];
    // Managed workspace guards execve the real command from a Node carrier.
    // Attribute the full guarded span without recording its path or payload.
    if (executable === path.basename(process.execPath)) {
      const direct = argv.findIndex(arg => arg === 'git');
      if (direct >= 0) { name = 'git'; argv = argv.slice(direct + 1); }
      else for (const arg of argv.slice(2, 5)) {
        try {
          const value = JSON.parse(arg);
          if (value?.command && Array.isArray(value.args) && path.basename(value.command) === 'git') { name = 'git'; argv = value.args; break; }
        } catch { /* not a structured guard invocation */ }
      }
    }
    const gitVerb = argv.find(arg => ['worktree', 'fetch', 'checkout', 'rebase', 'status', 'rev-parse'].includes(arg));
    const operation = name === 'git' ? gitVerb === 'worktree' ? `worktree:${['add', 'list', 'remove', 'prune'].includes(argv[argv.indexOf(gitVerb) + 1]) ? argv[argv.indexOf(gitVerb) + 1] : 'other'}` : gitVerb ?? 'other' : 'process';
    emit({ id, method, event: 'start', command: name, executable, operation });
    try {
      const child = Reflect.apply(original, this, [command, ...args]);
      if (method.endsWith('Sync')) { emit({ id, event: 'exit' }); return child; }
      child.once('spawn', () => emit({ id, event: 'spawned', childPid: child.pid ?? null }));
      let firstByte = false;
      let firstToken = false;
      let buffer = '';
      child.stdout?.on('data', chunk => {
        if (!firstByte) { firstByte = true; emit({ id, event: 'stdout', childPid: child.pid }); }
        buffer = (buffer + chunk.toString()).slice(-262144);
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!firstToken && (/"method"\s*:\s*"item\/agentMessage\/delta"/.test(line) || /"type"\s*:\s*"text_delta"/.test(line) || /"type"\s*:\s*"assistant"/.test(line))) {
            firstToken = true; emit({ id, event: 'assistant-output', childPid: child.pid });
          }
        }
      });
      child.once('error', () => emit({ id, event: 'error' }));
      child.once('exit', (code, signal) => emit({ id, event: 'exit', code, signal }));
      return child;
    } catch (error) { emit({ id, event: 'error' }); throw error; }
  };
  // util.promisify(execFile) has a multi-result contract. Losing that symbol
  // changes {stdout, stderr} into a string and corrupts the measured program.
  if (method === 'execFile') {
    cp[method][require('node:util').promisify.custom] = (...args) => {
      let child;
      const pending = new Promise((resolve, reject) => {
        child = cp[method](...args, (error, stdout, stderr) => {
          if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
          else resolve({ stdout, stderr });
        });
      });
      pending.child = child;
      return pending;
    };
  }
}
// ESM production imports must see the instrumented built-in exports too.
require('node:module').syncBuiltinESMExports();
