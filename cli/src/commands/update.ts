import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../output.js';

interface UpdateApplyResponse {
  ok?: boolean;
  requested?: boolean;
  forced?: boolean;
  message?: string;
  error?: { code?: string; message?: string };
  idle?: {
    idle?: boolean;
    active?: {
      lanes?: Array<{ id?: string; label?: string; status?: string }>;
      terminalSessions?: Array<{ name?: string; kind?: string }>;
      managedRuns?: Array<{ id?: string; command?: string }>;
      ownedSessions?: Array<{ surfaceId?: string; pid?: number | null; tmuxSession?: string | null }>;
    };
    unavailable?: string[];
  };
  state?: { version?: string | null };
}

export async function runUpdate(
  mode: OutputMode,
  subcommand: string | undefined,
  rest: string[],
): Promise<number> {
  if (subcommand !== 'apply') {
    throw new CliError(
      'unknown_update_subcommand',
      `Unknown update subcommand: ${subcommand ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Run `o8 update apply [--force]`.',
    );
  }
  const unknown = rest.find((arg) => arg !== '--force');
  if (unknown) {
    throw new CliError(
      'unknown_update_apply_flag',
      `Unknown update apply flag: ${unknown}`,
      EXIT.INVALID_ARGS,
      'Run `o8 update apply [--force]`.',
    );
  }

  const force = rest.includes('--force');
  const response = await apiFetch<UpdateApplyResponse>(
    resolveConfig(),
    '/api/panel/update/apply',
    { method: 'POST', body: { force }, allowConflict: true },
  );
  const data = response.data ?? {};
  const payload = {
    schema: 'o8/cli/update.apply/v1',
    ok: data.ok === true,
    requested: data.requested === true,
    forced: data.forced === true,
    version: data.state?.version ?? null,
    message: data.message ?? data.error?.message ?? null,
    error: data.error ?? null,
    idle: data.idle ?? null,
  };

  if (mode.human) {
    printHumanHeading('o8 update apply');
    process.stdout.write(`  ${payload.message ?? (payload.requested ? 'Update apply requested.' : 'Update apply refused.')}\n`);
    const active = data.idle?.active;
    for (const lane of active?.lanes ?? []) {
      process.stdout.write(`  lane ${lane.label ?? lane.id ?? 'unknown'} (${lane.status ?? 'active'})\n`);
    }
    for (const session of active?.terminalSessions ?? []) {
      process.stdout.write(`  terminal ${session.name ?? 'unknown'} (${session.kind ?? 'live'})\n`);
    }
    for (const run of active?.managedRuns ?? []) {
      process.stdout.write(`  run ${run.id ?? 'unknown'}${run.command ? `: ${run.command}` : ''}\n`);
    }
    for (const session of active?.ownedSessions ?? []) {
      process.stdout.write(`  owned ${session.surfaceId ?? 'unknown'} (${session.tmuxSession ?? session.pid ?? 'live'})\n`);
    }
  } else {
    printJson(payload);
  }

  return response.status === 409 ? EXIT.CONFLICT : 0;
}
