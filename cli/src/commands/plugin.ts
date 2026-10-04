import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';
import { randomUUID } from 'node:crypto';

type Action = { id: string; description: string; timeoutMs: number };
type Installed = {
  manifest: { id: string; name: string; supportedPlatforms: string[]; workspace: 'none' | 'registered-project'; actions: Action[] };
  revision: string;
  enabled: boolean;
  workspaceRoot: string | null;
  source?: { kind: 'github'; repository: string; commit: string; directory: string };
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
  source: Installed['source'] | null;
};
type TerminalReceipt = { id: string; pluginId: string; terminalId: string; sessionName: string; status: string; label: string; error: string | null };
type Inventory = { installed: Installed[]; receipts: Receipt[]; terminals?: TerminalReceipt[] };
type InvokeResult = { receipt: { id: string; pluginId: string; actionId: string; revision: string; status: string; actor: string; actorKind: 'authorization-class'; actorIdentity: null; exitCode: number | null; stdout: string; stderr: string; error: string | null; source: Installed['source'] | null } };
type SourceReview = { manifest: { name: string }; revision: string; sourceDirectory: string; source?: Installed['source']; files: Array<{ path: string; content: string; sha256: string }>; execution: { cwd: string; environmentKeys: string[] } };

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
  } else printJson({ schema: 'o8/cli/plugin.list/v1', plugins: installed.map(({ manifest, revision, enabled, workspaceRoot, source }) => ({ manifest, revision, enabled, workspaceRoot, ...(source ? { source } : {}) })) });
}

export async function runPlugin(mode: OutputMode, group: string | undefined, rest: string[]): Promise<number> {
  if (group === 'terminal' && rest[0] === 'list') {
    const { positional, flags } = parse(rest.slice(1), ['--plugin']);
    if (positional.length) throw new CliError('invalid_args', 'Use `o8 plugin terminal list [--plugin ID]`.', EXIT.INVALID_ARGS);
    const terminals = (await inventory(flags.get('--plugin'))).terminals ?? [];
    if (mode.human) {
      printHumanHeading('plugin terminals');
      for (const terminal of terminals) process.stdout.write(`  ${terminal.id}  ${terminal.label}  ${terminal.status}  ${terminal.sessionName}\n`);
    } else printJson({ schema: 'o8/cli/plugin.terminal.list/v1', terminals });
    return EXIT.OK;
  }
  if (group === 'terminal' && (rest[0] === 'launch' || rest[0] === 'stop')) {
    const launch = rest[0] === 'launch';
    const { positional, flags } = parse(rest.slice(1), launch ? ['--revision', '--repo', '--request'] : []);
    if (positional.length !== (launch ? 2 : 1) || (launch && !/^[a-f0-9]{64}$/.test(flags.get('--revision') ?? ''))) throw new CliError('invalid_args', 'Use `o8 plugin terminal launch <plugin-id> <entry-id> --revision <sha256> [--repo <path>] [--request <uuid>]` or `o8 plugin terminal stop <receipt-id>`.', EXIT.INVALID_ARGS);
    const requestId = flags.get('--request') ?? randomUUID();
    const result = await apiFetch<{ terminal: TerminalReceipt }>(operatorConfig(), '/api/customize/actions', {
      method: 'POST', timeoutMs: 30_000,
      body: launch ? { action: 'launch-terminal', id: positional[0], terminalId: positional[1], revision: flags.get('--revision'), requestId, ...(flags.has('--repo') ? { repo: flags.get('--repo') } : {}) } : { action: 'stop-terminal', receiptId: positional[0] },
    }).catch((error: unknown) => {
      if (launch && error instanceof CliError) error.hint = `Inspect o8 plugin terminal list before retrying. Reuse --request ${requestId} to avoid a duplicate launch. ${error.hint ?? ''}`.trim();
      throw error;
    });
    if (!result.data?.terminal) throw new CliError('invalid_response', `Terminal result unavailable. Inspect plugin terminal list before retrying${launch ? ` with --request ${requestId}` : ''}.`, EXIT.CONFLICT);
    const terminal = result.data.terminal;
    if (mode.human) printHumanKv([['receipt', terminal.id], ['terminal', terminal.sessionName], ['status', terminal.status], ['error', terminal.error ?? '(none)']]);
    else printJson({ schema: `o8/cli/plugin.terminal.${rest[0]}/v1`, terminal });
    return ['failed', 'launching'].includes(terminal.status) ? EXIT.CONFLICT : EXIT.OK;
  }
  if (group === 'source' && rest[0] === 'review') {
    const { positional, flags } = parse(rest.slice(1), ['--directory', '--github', '--commit', '--path', '--repo']);
    const github = flags.get('--github');
    const directory = flags.get('--directory');
    if (positional.length || (!github === !directory) || (github ? !/^[a-f0-9]{40}$/.test(flags.get('--commit') ?? '') : flags.has('--commit') || flags.has('--path'))) {
      throw new CliError('invalid_args', 'Use `o8 plugin source review --directory <local-folder>` or `--github <owner/repository> --commit <40-character-sha> [--path <package-directory>]`, with optional --repo.', EXIT.INVALID_ARGS);
    }
    const body = github ? { action: 'review-github', repository: github, commit: flags.get('--commit'), directory: flags.get('--path') ?? '' } : { action: 'review', directory };
    const result = await apiFetch<{ review: SourceReview }>(operatorConfig(), '/api/customize/actions', { method: 'POST', timeoutMs: 45_000, body: { ...body, ...(flags.has('--repo') ? { repo: flags.get('--repo') } : {}) } });
    if (!result.data?.review?.revision || !result.data.review.sourceDirectory) throw new CliError('invalid_response', 'The action host returned no source review.', EXIT.INVALID_ARGS);
    const review = result.data.review;
    if (mode.human) {
      printHumanHeading('plugin source review');
      printHumanKv([['plugin', review.manifest.name], ['revision', review.revision], ['directory', review.sourceDirectory], ['working directory', review.execution.cwd], ['environment', review.execution.environmentKeys.join(', ')]]);
      if (review.source) printHumanKv([['source', `${review.source.repository}@${review.source.commit}/${review.source.directory}`]]);
      for (const file of review.files) process.stdout.write(`\n${file.path} · ${file.sha256}\n${file.content}\n`);
    } else printJson({ schema: 'o8/cli/plugin.source.review/v1', review });
    return EXIT.OK;
  }
  if (group === 'source' && rest[0] === 'link') {
    const { positional, flags } = parse(rest.slice(1), ['--directory', '--revision', '--repo']);
    if (positional.length || !flags.get('--directory') || !/^[a-f0-9]{64}$/.test(flags.get('--revision') ?? '')) throw new CliError('invalid_args', 'Use `o8 plugin source link --directory <reviewed-folder> --revision <sha256> [--repo <registered-path>]`.', EXIT.INVALID_ARGS);
    const result = await apiFetch<{ installed: Installed }>(operatorConfig(), '/api/customize/actions', { method: 'POST', body: { action: 'link', directory: flags.get('--directory'), expectedRevision: flags.get('--revision'), ...(flags.has('--repo') ? { repo: flags.get('--repo') } : {}) } });
    if (!result.data?.installed) throw new CliError('invalid_response', 'The action host returned no installation.', EXIT.INVALID_ARGS);
    if (mode.human) pluginList(mode, [result.data.installed]);
    else printJson({ schema: 'o8/cli/plugin.source.link/v1', installed: result.data.installed });
    return EXIT.OK;
  }
  if (group === 'state' && rest[0] === 'clear') {
    const { positional, flags } = parse(rest.slice(1).filter((arg) => arg !== '--confirm'), ['--revision']);
    if (positional.length !== 1 || rest.filter((arg) => arg === '--confirm').length !== 1 || !/^[a-f0-9]{64}$/.test(flags.get('--revision') ?? '')) throw new CliError('invalid_args', 'Use `o8 plugin state clear <plugin-id> --revision <sha256> --confirm`. This permanently clears this source and project’s saved data.', EXIT.INVALID_ARGS);
    const result = await apiFetch<{ cleared: boolean; cleanupPending: boolean }>(operatorConfig(), '/api/customize/actions', { method: 'POST', body: { action: 'clear-state', id: positional[0], revision: flags.get('--revision'), confirmed: true } });
    if (typeof result.data?.cleared !== 'boolean') throw new CliError('invalid_response', 'The action host returned no state result.', EXIT.INVALID_ARGS);
    if (mode.human) printHumanKv([['cleared', String(result.data.cleared)], ['cleanup pending', String(result.data.cleanupPending)]]);
    else printJson({ schema: 'o8/cli/plugin.state.clear/v1', ...result.data });
    return EXIT.OK;
  }
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
  throw new CliError('unknown_plugin_subcommand', 'Use `o8 plugin source review|link`, `o8 plugin list`, `o8 plugin action list|invoke`, `o8 plugin terminal list|launch|stop`, `o8 plugin log list`, or `o8 plugin state clear`.', EXIT.INVALID_ARGS);
}
