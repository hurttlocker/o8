import { EMBEDDED_CHILD_POLICY_SCRIPT } from './embedded-child-policy';
import { providerCanonicalName, providerCredentialName, providerSpawnEnvironment } from './spawn-environment';

const MCP_LAUNCH_SCRIPT = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const spec = JSON.parse(process.argv[1]);
const inherited = process.env;
withO8ChildPolicy(env => {
  const stamp = JSON.parse(inherited.O8_CHILD_CREDENTIAL_POLICY || 'null');
  if (!stamp || stamp.runtimeId !== spec.runtimeId) throw new Error('MCP runtime credential identity unavailable.');
  for (const [name, canonical] of Object.entries(spec.slots)) {
    delete env[name];
    if (stamp.apiAllowed && inherited[canonical]) env[name] = inherited[canonical];
  }
  const child = require('node:child_process').spawn(spec.command, spec.args, { env, stdio: 'inherit', windowsHide: true });
  child.once('error', () => { process.exitCode = 1; });
  child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
});
`;

/** MCP configs retain credential references; aliases resolve at the actual server launch. */
export function prepareProviderMcpLaunch<T extends { command: string; args?: string[]; env?: Record<string, string> | null }>(server: T, runtimeId: string): T & { args: string[]; env: Record<string, string> } {
  if (server.args?.[0] === '-e' && server.args[1] === MCP_LAUNCH_SCRIPT) return server as T & { args: string[]; env: Record<string, string> };
  const input = server.env ?? {};
  const slots = Object.fromEntries(Object.keys(input).filter(providerCredentialName).flatMap(name => {
    const canonical = providerCanonicalName(input, name);
    return canonical ? [[name, canonical]] : [];
  }));
  const env: Record<string, string> = providerSpawnEnvironment(input, { runtimeId, inject: false, onlyExisting: true });
  if (!('NODE_ENV' in input)) delete env.NODE_ENV;
  if (!Object.keys(slots).length) return { ...server, args: server.args ?? [], env };
  return { ...server, command: process.execPath, args: ['-e', MCP_LAUNCH_SCRIPT, JSON.stringify({ runtimeId, command: server.command, args: server.args ?? [], slots })], env };
}

export function providerMcpLaunchRequiresPolicy(server: { args?: string[] }): boolean {
  return server.args?.[0] === '-e' && server.args[1] === MCP_LAUNCH_SCRIPT;
}
