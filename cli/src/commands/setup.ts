import { resolve } from 'node:path';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';

export async function runSetup(_mode: OutputMode, action: string | undefined, args: string[]) {
  let body: Record<string, unknown> | undefined;
  if (action === 'status') {
    if (args.length) throw new CliError('invalid_args', 'setup status takes no arguments.', EXIT.INVALID_ARGS);
  } else if (action === 'open' || action === 'cancel') {
    if (args.length !== 1 || args[0]!.startsWith('-')) throw new CliError('invalid_args', `setup ${action} requires one ${action === 'open' ? 'path' : 'request id'}.`, EXIT.INVALID_ARGS);
    body = { action, [action === 'open' ? 'path' : 'requestId']: action === 'open' ? resolve(args[0]!) : args[0] };
  } else if (action === 'configure') {
    body = { action };
    const keys: Record<string, string> = { '--lead': 'orchestratorRuntime', '--workers': 'workerRuntimes', '--lead-model': 'leadModel', '--worker-model': 'workerModel' };
    for (let index = 0; index < args.length; index += 2) {
      const key = keys[args[index]!];
      const value = args[index + 1];
      if (!key || !value || value.startsWith('--') || key in body) throw new CliError('invalid_args', 'Use --lead runtime --workers runtime[,runtime] [--lead-model model] [--worker-model model].', EXIT.INVALID_ARGS);
      body[key] = key === 'workerRuntimes' ? value.split(',').map((item) => item.trim()) : value;
    }
  } else throw new CliError('invalid_args', 'Use: o8 setup status | configure | open <path> | cancel <request-id>', EXIT.INVALID_ARGS);
  const response = await apiFetch(resolveConfig(), '/api/setup/agent', body ? { method: 'POST', body } : {});
  printJson(response.data);
}
