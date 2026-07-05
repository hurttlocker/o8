import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../output.js';

interface AppRestartResponse {
  ok?: boolean;
  relaunched?: boolean;
  skipped?: boolean;
  reason?: string;
  message?: string;
  state?: {
    updatePending?: boolean;
    version?: string | null;
    updatedAt?: string | null;
  };
}

export async function runApp(mode: OutputMode, subcommand: string | undefined, rest: string[]): Promise<number> {
  if (subcommand !== 'restart') {
    throw new CliError(
      'unknown_app_subcommand',
      `Unknown app subcommand: ${subcommand ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Run `o8 app restart [--if-update-pending]`.',
    );
  }

  const unknown = rest.find((arg) => arg !== '--if-update-pending');
  if (unknown) {
    throw new CliError(
      'unknown_app_restart_flag',
      `Unknown app restart flag: ${unknown}`,
      EXIT.INVALID_ARGS,
      'Run `o8 app restart [--if-update-pending]`.',
    );
  }

  const ifUpdatePending = rest.includes('--if-update-pending');
  const cfg = resolveConfig();
  const res = await apiFetch<AppRestartResponse>(cfg, '/api/panel/app/relaunch', {
    method: 'POST',
    body: { ifUpdatePending },
  });
  const data = res.data ?? {};
  const payload = {
    schema: 'o8/cli/app.restart/v1',
    ok: data.ok === true,
    requested: data.relaunched === true,
    skipped: data.skipped === true,
    reason: data.reason ?? null,
    message: data.message ?? null,
    updatePending: data.state?.updatePending === true,
    version: data.state?.version ?? null,
  };

  if (mode.human) {
    printHumanHeading('o8 app restart');
    process.stdout.write(`  ${payload.message ?? (payload.requested ? 'Restart requested.' : 'No restart requested.')}\n`);
    if (payload.version) process.stdout.write(`  update ${payload.version}\n`);
  } else {
    printJson(payload);
  }

  return 0;
}
