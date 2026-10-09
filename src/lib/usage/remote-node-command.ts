/** Fixed bootstrap for PATH-managed and nvm-managed Node, without changing the remote shell configuration. */
export const REMOTE_NODE_COMMAND = [
  'if command -v node >/dev/null 2>&1; then exec node --no-warnings -; fi;',
  'for candidate in "$HOME"/.nvm/versions/node/v22.*/bin/node; do',
  'if [ -x "$candidate" ]; then exec "$candidate" --no-warnings -; fi; done;',
  'printf "%s\\n" "Node 22 is required to read usage on this machine." >&2; exit 1',
].join(' ');

export function savedMachineSshArgs(machine: { target: string; port: number; sshConfig: string | null }) {
  const command = `sh -c '${REMOTE_NODE_COMMAND.replaceAll("'", "'\\''")}'`;
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
    '-o', 'NumberOfPasswordPrompts=0', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
    ...(machine.sshConfig ? ['-F', machine.sshConfig] : []), '-p', String(machine.port), '--', machine.target, command];
}
