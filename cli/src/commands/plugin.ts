import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

type Action = { id: string; description: string; timeoutMs: number };
type Installed = {
  manifest: { id: string; name: string; supportedPlatforms: string[]; workspace: 'none' | 'registered-project'; actions: Action[] };
  revision: string;
  enabled: boolean;
  workspaceRoot: string | null;
};
type Receipt = {
  id: string;
  plugin_id: string;
  action_id: string;
  revision: string;
  status: string;
  started_at: string;
  actor: string;
  actorKind: 'authorization-class';
  actorIdentity: null;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
};
type Inventory = { installed: Installed[]; receipts: Receipt[] };
type InvokeResult = { receipt: { id: string; pluginId: string; actionId: string; revision: string; status: string; actor: string; actorKind: 'authorization-class'; actorIdentity: null; exitCode: number | null; stdout: string; stderr: string; error: string | null } };

function parse(args: string[], valueFlags: string[]) {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word.startsWith('--')) {
      if (!valueFlags.includes(word) || flags.has(word)) throw new CliError('invalid_args', `Unknown or repeated option: ${word}`, EXIT.INVALID_ARGS);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new CliError('invalid_args', `${word} needs a value.`, EXIT.INVALID_ARGS);
      flags.set(word, value);
    } else if (word.startsWith('-')) throw new CliError('invalid_args', `Unknown option: ${word}`, EXIT.INVALID_ARGS);
    else positional.push(word);
  }
  return { positional, flags };
}

function operatorConfig() {
  const config = resolveConfig();
  if (config.source.token === 'worker' || process.env.O8_SPECTATOR_TOKEN?.trim()) {
    throw new CliError('operator_required', 'Action plugins require the local operator control plane.', EXIT.UNAUTHORIZED);
  }
  return config;
}

async function inventory(receiptPlugin?: string) {
  const query = receiptPlugin ? `?plugin=${encodeURIComponent(receiptPlugin)}` : '';
  const result = await apiFetch<Inventory>(operatorConfig(), `/api/customize/actions${query}`);
  if (!result.data || !Array.isArray(result.data.installed) || !Array.isArray(result.data.receipts)) {
    throw new CliError('invalid_response', 'The action host returned an invalid inventory.', EXIT.INVALID_ARGS);
  }
  return result.data;
}

function pluginList(mode: OutputMode, installed: Installed[]) {
  if (mode.human) {
    printHumanHeading('action plugins');
    if (installed.length === 0) process.stdout.write('  (none)\n');
    for (const plugin of installed) {
      process.stdout.write(`  ${plugin.manifest.id}  ${plugin.enabled ? 'enabled' : 'disabled'}  ${plugin.revision}\n`);
      process.stdout.write(`    ${plugin.manifest.name} · ${plugin.manifest.workspace === 'none' ? 'private snapshot' : plugin.workspaceRoot ?? 'project unavailable'}\n`);
    }
  } else printJson({ schema: 'o8/cli/plugin.list/v1', plugins: installed.map(({ manifest, revision, enabled, workspaceRoot }) => ({ manifest, revision, enabled, workspaceRoot })) });
}

export async function runPlugin(mode: OutputMode, group: string | undefined, rest: string[]): Promise<number> {
  if (group === 'list') {
    const { positional, flags } = parse(rest, ['--plugin']);
    if (positional.length) throw new CliError('invalid_args', 'Use `o8 plugin list [--plugin ID]`.', EXIT.INVALID_ARGS);
    const found = (await inventory()).installed.filter((plugin) => !flags.get('--plugin') || plugin.manifest.id === flags.get('--plugin'));
    pluginList(mode, found);
    return EXIT.OK;
  }
  if (group === 'action' && rest[0] === 'list') {
    const { positional, flags } = parse(rest.slice(1), ['--plugin']);
    if (positional.length) throw new CliError('invalid_args', 'Use `o8 plugin action list [--plugin ID]`.', EXIT.INVALID_ARGS);
    const actions = (await inventory()).installed
      .filter((plugin) => !flags.get('--plugin') || plugin.manifest.id === flags.get('--plugin'))
      .flatMap((plugin) => plugin.manifest.actions.map((action) => ({ pluginId: plugin.manifest.id, revision: plugin.revision, enabled: plugin.enabled, workspace: plugin.manifest.workspace, workspaceRoot: plugin.workspaceRoot, supportedPlatforms: plugin.manifest.supportedPlatforms, ...action })));
    if (mode.human) {
      printHumanHeading('plugin actions');
      if (actions.length === 0) process.stdout.write('  (none)\n');
      for (const action of actions) process.stdout.write(`  ${action.pluginId}/${action.id}  ${action.enabled ? 'enabled' : 'disabled'}  ${action.revision}  ${action.description}\n`);
    } else printJson({ schema: 'o8/cli/plugin.action.list/v1', actions });
    return EXIT.OK;
  }
  if (group === 'action' && rest[0] === 'invoke') {
    const { positional, flags } = parse(rest.slice(1), ['--revision', '--repo']);
    if (positional.length !== 2 || !/^[a-f0-9]{64}$/.test(flags.get('--revision') ?? '')) {
      throw new CliError('invalid_args', 'Use `o8 plugin action invoke <plugin-id> <action-id> --revision <sha256> [--repo <registered-path>]`.', EXIT.INVALID_ARGS);
    }
    const [id, actionId] = positional;
    const result = await apiFetch<InvokeResult>(operatorConfig(), '/api/customize/actions', {
      method: 'POST', timeoutMs: 45_000,
      body: { action: 'invoke', id, actionId, revision: flags.get('--revision'), ...(flags.has('--repo') ? { repo: flags.get('--repo') } : {}) },
    });
    if (!result.data?.receipt) throw new CliError('invalid_response', 'The action host returned no run receipt.', EXIT.INVALID_ARGS);
    const receipt = result.data.receipt;
    if (mode.human) {
      printHumanHeading('plugin action');
      printHumanKv([['receipt', receipt.id], ['status', receipt.status], ['revision', receipt.revision], ['actor', `${receipt.actor} (${receipt.actorKind}; identity unverified)`], ['exit', receipt.exitCode === null ? '(none)' : String(receipt.exitCode)]]);
      if (receipt.stdout) process.stdout.write(`\n${receipt.stdout}`);
      if (receipt.stderr) process.stderr.write(`\n${receipt.stderr}`);
      if (receipt.error) process.stderr.write(`\n${receipt.error}\n`);
    } else printJson({ schema: 'o8/cli/plugin.action.invoke/v1', receipt });
    return receipt.status === 'succeeded' ? EXIT.OK : EXIT.INVALID_ARGS;
  }
  if (group === 'log' && rest[0] === 'list') {
    const { positional, flags } = parse(rest.slice(1), ['--plugin', '--limit']);
    const limit = flags.has('--limit') ? Number(flags.get('--limit')) : 20;
    if (positional.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CliError('invalid_args', 'Use `o8 plugin log list [--plugin ID] [--limit 1..100]`.', EXIT.INVALID_ARGS);
    const receipts = (await inventory(flags.get('--plugin'))).receipts.slice(0, limit);
    if (mode.human) {
      printHumanHeading('plugin runs');
      if (receipts.length === 0) process.stdout.write('  (none)\n');
      for (const receipt of receipts) process.stdout.write(`  ${receipt.id}  ${receipt.plugin_id}/${receipt.action_id}  ${receipt.status}  ${receipt.started_at}\n`);
    } else printJson({ schema: 'o8/cli/plugin.log.list/v1', receipts });
    return EXIT.OK;
  }
  throw new CliError('unknown_plugin_subcommand', 'Use `o8 plugin list`, `o8 plugin action list|invoke`, or `o8 plugin log list`.', EXIT.INVALID_ARGS);
}
