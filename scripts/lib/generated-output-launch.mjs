import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function generatedOutputLaunch(mode, args = []) {
  return { command: process.execPath, args: [
    '--import', fileURLToPath(new URL('../register-server-only-stub.mjs', import.meta.url)),
    '--import', require.resolve('tsx'),
    fileURLToPath(new URL('../generated-output-run.ts', import.meta.url)), mode, ...args,
  ] };
}

export async function runGeneratedOutputLaunch(mode, args = [], env = process.env) {
  const invocation = generatedOutputLaunch(mode, args);
  const child = spawn(invocation.command, invocation.args, { cwd: process.cwd(), env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
