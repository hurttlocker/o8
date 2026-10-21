import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { getDataDir } from '@/lib/data-dir-migration';
import { createBroadcastRedactionContext, redactBroadcastText } from '@/lib/broadcast/redaction';
import { resolveScope } from '@/lib/customize/storage';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { WorktreeMetaEntry } from '@/lib/worktree/types';
import { ActionPluginError } from './errors';
import { acquiredSource, githubSourceSchema, type GithubActionSource } from './source-storage';
import { verifyGithubFiles } from './github-files';
import { actionStateSchema, clearActionState, describeActionState, provisionActionState, type ActionState } from './state-storage';
import { inspectPluginTerminal, pluginTerminalEnvironment, requirePluginTerminalRuntime, startPluginTerminal, stopPluginTerminal } from './terminal-runtime';

export { ActionPluginError } from './errors';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const fileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(128).refine((name) => name !== '.' && name !== '..' && name !== 'installed.json' && name !== 'o8-actions.json');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Keep the action in a separate process group, with an IPC watchdog that survives
// the host long enough to terminate the group if the host exits unexpectedly.
const actionRunner = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const expected = process.argv[1] ? JSON.parse(process.argv[1]) : null;
const entry = process.argv[2];
const args = process.argv.slice(3);
const stop = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } };
process.on('disconnect', stop);
process.on('SIGTERM', stop);
const timer = setTimeout(stop, Number(process.env.O8_ACTION_TIMEOUT_MS) + 1000);
let action;
let permitted = true;
if (expected) {
  try {
    const actual = fs.lstatSync('.');
    if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.device
      || actual.ino !== expected.inode || fs.realpathSync('.') !== expected.canonicalPath) {
      throw new Error('Managed workspace ownership changed before action execution.');
    }
  } catch (error) {
    permitted = false;
    process.send?.({ type: 'spawn_error', message: error.message }, () => process.exit(78));
  }
}
try { if (permitted) { action = spawn(entry, args, { stdio: ['pipe', 'inherit', 'inherit'], env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV, ...(process.env.O8_PLUGIN_STATE_DIR ? { O8_PLUGIN_STATE_DIR: process.env.O8_PLUGIN_STATE_DIR } : {}) } }); action.stdin.on('error', () => {}); process.stdin.pipe(action.stdin); } }
catch (error) { process.send?.({ type: 'spawn_error', message: error.message }, () => process.exit(1)); }
if (action) {
  action.on('error', (error) => process.send?.({ type: 'spawn_error', message: error.message }, () => process.exit(1)));
  action.on('exit', (code) => {
    clearTimeout(timer);
    process.send?.({ type: 'complete', code }, stop);
  });
}
`;
export const actionManifestSchema = z.object({
  format: z.literal('o8-actions-v1'),
  id: slug,
  name: z.string().trim().min(1).max(100),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  description: z.string().trim().min(1).max(500),
  supportedPlatforms: z.array(z.enum(['darwin', 'linux'])).min(1).max(2).refine((items) => new Set(items).size === items.length),
  workspace: z.enum(['none', 'registered-project']),
  state: z.object({ scope: z.literal('source-and-project') }).strict().optional(),
  files: z.array(z.object({ path: fileName, sha256: digest }).strict()).min(1).max(12),
  actions: z.array(z.object({
    id: slug,
    description: z.string().trim().min(1).max(500),
    entry: fileName,
    args: z.array(z.string().max(256).refine((arg) => !arg.includes('\0'), 'Arguments cannot contain NUL characters.')).max(16).default([]),
    timeoutMs: z.number().int().min(100).max(30_000),
  }).strict()).max(12),
  terminals: z.array(z.object({
    id: slug,
    description: z.string().trim().min(1).max(500),
    entry: fileName,
    args: z.array(z.string().max(256).refine((arg) => !arg.includes('\0'), 'Arguments cannot contain NUL characters.')).max(16).default([]),
  }).strict()).min(1).max(12).optional(),
  triggers: z.array(z.object({
    id: slug,
    event: z.literal('worktree.created'),
    actionId: slug,
  }).strict()).max(12).optional(),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.triggers?.length && manifest.workspace !== 'registered-project') ctx.addIssue({ code: 'custom', message: 'Triggers require a registered project' });
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) ctx.addIssue({ code: 'custom', message: 'Duplicate files' });
  if (new Set(manifest.actions.map((action) => action.id)).size !== manifest.actions.length) ctx.addIssue({ code: 'custom', message: 'Duplicate actions' });
  if (new Set((manifest.triggers ?? []).map((trigger) => trigger.id)).size !== (manifest.triggers ?? []).length) ctx.addIssue({ code: 'custom', message: 'Duplicate triggers' });
  for (const action of manifest.actions) if (!manifest.files.some((file) => file.path === action.entry)) ctx.addIssue({ code: 'custom', message: 'Action entry is not a declared file' });
  for (const trigger of manifest.triggers ?? []) if (!manifest.actions.some((action) => action.id === trigger.actionId)) ctx.addIssue({ code: 'custom', message: 'Trigger action is not declared' });
  if (!manifest.actions.length && !manifest.terminals?.length) ctx.addIssue({ code: 'custom', message: 'Declare an action or a terminal' });
  if (manifest.terminals && new Set(manifest.terminals.map((terminal) => terminal.id)).size !== manifest.terminals.length) ctx.addIssue({ code: 'custom', message: 'Duplicate terminals' });
  for (const terminal of manifest.terminals ?? []) if (!manifest.files.some((file) => file.path === terminal.entry)) ctx.addIssue({ code: 'custom', message: 'Terminal entry is not a declared file' });
});
export type ActionManifest = z.infer<typeof actionManifestSchema>;
type Saved = { manifest: ActionManifest; revision: string; enabled: boolean; enabledAt?: string | null; enabledTriggers: string[]; triggerEnabledAt?: Record<string, string>; triggerConsentIds?: Record<string, string>; linkedAt: string; sourceDirectory: string; workspaceRoot: string | null; source?: GithubActionSource };
function sha(data: Buffer | string) { return createHash('sha256').update(data).digest('hex'); }
function revisionFor(manifest: ActionManifest, workspaceRoot: string | null, sourceDirectory: string, source?: GithubActionSource) { return sha(JSON.stringify({ manifest, workspaceRoot, sourceDirectory, ...(source ? { source } : {}) })); }
function root(create: boolean) {
  let at = getDataDir();
  if (create && !existsSync(at)) mkdirSync(at, { recursive: true, mode: 0o700 });
  if (!lstatSync(at).isDirectory() || lstatSync(at).isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Invalid data directory.');
  for (const part of ['customizations', 'actions']) {
    at = path.join(at, part);
    if (create && !existsSync(at)) mkdirSync(at, { mode: 0o700 });
    if (!lstatSync(at).isDirectory() || lstatSync(at).isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Invalid action storage directory.');
  }
  return at;
}
function sourceDir(input: string) {
  if (!path.isAbsolute(input)) throw new ActionPluginError('unsafe_path', 'Choose an absolute local folder.');
  let at = path.parse(input).root;
  for (const part of input.slice(at.length).replace(/\/+$/, '').split(path.sep)) {
    if (!part || part === '.' || part === '..') throw new ActionPluginError('unsafe_path', 'Linked folders and traversal are not allowed.');
    at = path.join(at, part);
    const stat = lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Linked folders are not allowed.');
  }
  return at;
}
function safeFile(dir: string, name: string, limit: number) {
  const file = path.join(dir, name);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new ActionPluginError('unsafe_file', 'Action file is linked, oversized, or invalid.');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const data = readFileSync(fd);
    if (data.length > limit) throw new ActionPluginError('too_large', 'Action file is too large.');
    return data;
  } finally { closeSync(fd); }
}
export async function reviewActionSource(directory: string, repo?: string, signal?: AbortSignal) {
  const dir = sourceDir(directory);
  const manifestBytes = safeFile(dir, 'o8-actions.json', 64 * 1024);
  const manifest = actionManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const source = acquiredSource(dir, manifestBytes);
  if (manifest.workspace === 'registered-project' && repo === undefined) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for review.');
  const workspaceRoot = manifest.workspace === 'none' ? null : await resolveScope(repo);
  if (manifest.workspace === 'registered-project' && !workspaceRoot) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for review.');
  const sourceFiles = [{ path: 'o8-actions.json', data: manifestBytes }];
  const files = manifest.files.map((file) => {
    const data = safeFile(dir, file.path, 1024 * 1024);
    sourceFiles.push({ path: file.path, data });
    if (sha(data) !== file.sha256) throw new ActionPluginError('digest_mismatch', `File ${file.path} changed or does not match its digest.`, 409);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new ActionPluginError('unreviewable_file', `File ${file.path} is not UTF-8 text and cannot be reviewed in this version.`); }
    if (content.includes('\0')) throw new ActionPluginError('unreviewable_file', `File ${file.path} contains NUL bytes and cannot be reviewed in this version.`);
    return { path: file.path, bytes: data.length, sha256: file.sha256, content };
  });
  if (source) await verifyGithubFiles(source, sourceFiles, signal);
  const state = manifest.state ? describeActionState({ id: manifest.id, sourceDirectory: dir, workspaceRoot, source }) : undefined;
  return {
    manifest, revision: revisionFor(manifest, workspaceRoot, dir, source), files, sourceDirectory: dir, ...(source ? { source } : {}),
    execution: { cwd: workspaceRoot ?? path.join(getDataDir(), 'customizations', 'actions', manifest.id), environmentKeys: ['PATH', 'NODE_ENV', ...(state ? [state.environmentKey] : [])], principal: 'local-user' as const, ...(state ? { state } : {}), ...(manifest.terminals ? { terminalEnvironmentKeys: Object.keys(pluginTerminalEnvironment(state?.directory)) } : {}) },
    workspaceRoot,
  };
}
function savedPath(id: string) { return path.join(root(false), slug.parse(id), 'installed.json'); }
function readSaved(id: string): Saved {
  const dir = path.dirname(savedPath(id));
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Invalid installation.');
  const saved = JSON.parse(safeFile(dir, 'installed.json', 64 * 1024).toString('utf8')) as Saved;
  const manifest = actionManifestSchema.parse(saved.manifest);
  const source = saved.source === undefined ? undefined : githubSourceSchema.parse(saved.source);
  if (manifest.id !== id || typeof saved.sourceDirectory !== 'string' || (saved.workspaceRoot !== null && typeof saved.workspaceRoot !== 'string')
    || saved.revision !== revisionFor(manifest, saved.workspaceRoot, saved.sourceDirectory, source) || typeof saved.enabled !== 'boolean'
    || (saved.enabled && saved.enabledAt === null)
    || (saved.enabledAt !== undefined && saved.enabledAt !== null && (typeof saved.enabledAt !== 'string' || Number.isNaN(Date.parse(saved.enabledAt))))
    || (saved.triggerEnabledAt !== undefined && (typeof saved.triggerEnabledAt !== 'object' || saved.triggerEnabledAt === null || Array.isArray(saved.triggerEnabledAt)
      || Object.entries(saved.triggerEnabledAt).some(([triggerId, enabledAt]) => !manifest.triggers?.some((trigger) => trigger.id === triggerId) || typeof enabledAt !== 'string' || Number.isNaN(Date.parse(enabledAt)))))
    || (saved.triggerConsentIds !== undefined && (typeof saved.triggerConsentIds !== 'object' || saved.triggerConsentIds === null || Array.isArray(saved.triggerConsentIds)
      || Object.entries(saved.triggerConsentIds).some(([triggerId, consentId]) => !manifest.triggers?.some((trigger) => trigger.id === triggerId) || !z.string().uuid().safeParse(consentId).success)))
    || (saved.enabledTriggers !== undefined && (!Array.isArray(saved.enabledTriggers) || new Set(saved.enabledTriggers).size !== saved.enabledTriggers.length
      || saved.enabledTriggers.some((triggerId) => typeof triggerId !== 'string' || !manifest.triggers?.some((trigger) => trigger.id === triggerId))))) throw new ActionPluginError('damaged', 'Action installation is damaged.');
  return { ...saved, manifest, enabledTriggers: saved.enabledTriggers ?? [] };
}
function db() {
  const file = path.join(root(true), 'receipts.sqlite');
  let fd: number;
  try { fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new ActionPluginError('unsafe_path', 'Invalid receipt storage file.');
    throw error;
  }
  closeSync(fd);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new ActionPluginError('unsafe_path', 'Invalid receipt storage file.');
  const database = new Database(file);
  database.exec('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, action_id TEXT NOT NULL, actor TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, stdout TEXT, stderr TEXT, error TEXT, source_metadata TEXT)');
  database.exec('CREATE TABLE IF NOT EXISTS terminal_receipts (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, receipt_json TEXT NOT NULL)');
  database.transaction(() => {
    const columns = database.prepare('PRAGMA table_info(receipts)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'source_metadata')) database.exec('ALTER TABLE receipts ADD COLUMN source_metadata TEXT');
    if (!columns.some((column) => column.name === 'state_metadata')) database.exec('ALTER TABLE receipts ADD COLUMN state_metadata TEXT');
    if (!columns.some((column) => column.name === 'event_id')) database.exec('ALTER TABLE receipts ADD COLUMN event_id TEXT');
    if (!columns.some((column) => column.name === 'trigger_id')) database.exec('ALTER TABLE receipts ADD COLUMN trigger_id TEXT');
  }).immediate();
  database.exec('CREATE TABLE IF NOT EXISTS trigger_events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)');
  database.exec('CREATE TABLE IF NOT EXISTS trigger_deliveries (event_id TEXT NOT NULL, plugin_id TEXT NOT NULL, trigger_id TEXT NOT NULL, action_id TEXT NOT NULL, revision TEXT NOT NULL, status TEXT NOT NULL, receipt_id TEXT, eligible_at_publish INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (event_id, plugin_id, trigger_id))');
  database.transaction(() => {
    const deliveryColumns = database.prepare('PRAGMA table_info(trigger_deliveries)').all() as { name: string }[];
    if (!deliveryColumns.some((column) => column.name === 'eligible_at_publish')) database.exec('ALTER TABLE trigger_deliveries ADD COLUMN eligible_at_publish INTEGER NOT NULL DEFAULT 0');
    if (!deliveryColumns.some((column) => column.name === 'consent_id')) database.exec('ALTER TABLE trigger_deliveries ADD COLUMN consent_id TEXT');
  }).immediate();
  return database;
}
function lifecycle<T>(action: (database: Database.Database) => T): T {
  const database = db();
  try { return database.transaction(() => action(database)).immediate(); }
  finally { database.close(); }
}
function refuseRunning(database: Database.Database, id: string) {
  for (const terminal of readTerminalReceipts(database, id)) {
    if (['launching', 'running'].includes(refreshTerminalReceipt(database, terminal).status)) throw new ActionPluginError('busy', 'Stop this plugin’s active or pending terminal before changing its installation or saved data.', 409);
  }
  const now = new Date().toISOString();
  database.prepare("UPDATE receipts SET status = 'interrupted', finished_at = ?, error = 'Host stopped before completion' WHERE plugin_id = ? AND status = 'running' AND started_at < ?")
    .run(now, id, new Date(Date.now() - 60_000).toISOString());
  const active = database.prepare("SELECT id FROM receipts WHERE plugin_id = ? AND status = 'running' LIMIT 1").get(id);
  if (active) throw new ActionPluginError('busy', 'An action from this plugin is running.', 409);
}

export type PluginTerminalReceipt = {
  id: string; pluginId: string; terminalId: string; revision: string; sessionName: string;
  label: string; workspaceRoot: string | null; source: GithubActionSource | null; state: ActionState | null;
  actor: 'local-operator'; startedAt: string; finishedAt: string | null;
  status: 'launching' | 'running' | 'exited' | 'ended' | 'stopped' | 'failed';
  exitCode: number | null; error: string | null;
};
function readTerminalReceipts(database: Database.Database, pluginId?: string): PluginTerminalReceipt[] {
  const rows = (pluginId
    ? database.prepare('SELECT receipt_json FROM terminal_receipts WHERE plugin_id = ? ORDER BY rowid DESC').all(pluginId)
    : database.prepare('SELECT receipt_json FROM terminal_receipts ORDER BY rowid DESC').all()) as Array<{ receipt_json: string }>;
  return rows.map((row) => JSON.parse(row.receipt_json) as PluginTerminalReceipt);
}
function saveTerminalReceipt(database: Database.Database, receipt: PluginTerminalReceipt) {
  database.prepare('INSERT INTO terminal_receipts (id, plugin_id, receipt_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET receipt_json = excluded.receipt_json')
    .run(receipt.id, receipt.pluginId, JSON.stringify(receipt));
  return receipt;
}
function refreshTerminalReceipt(database: Database.Database, receipt: PluginTerminalReceipt) {
  if (!['launching', 'running', 'exited'].includes(receipt.status)) return receipt;
  try {
    const current = inspectPluginTerminal(receipt.sessionName);
    // Missing does not mean a pending launch has finished: the host may have
    // stopped before spawn, or another process may be between claim and spawn.
    // Only explicit Stop cancels this claim. Replays never execute it again.
    if (receipt.status === 'launching' && current.status === 'ended') return receipt;
    return saveTerminalReceipt(database, { ...receipt, ...current, error: null, finishedAt: current.status === 'running' ? null : receipt.finishedAt ?? new Date().toISOString() });
  } catch {
    return saveTerminalReceipt(database, { ...receipt, error: 'Terminal status is unavailable. The session remains reserved; retry inspection or stop it before launching again.' });
  }
}
export function pluginTerminalReceipts(pluginId?: string) {
  return lifecycle((database) => readTerminalReceipts(database, pluginId).map((receipt) => refreshTerminalReceipt(database, receipt)));
}
export function pluginTerminalSessionReferences() {
  if (!existsSync(path.join(getDataDir(), 'customizations', 'actions', 'receipts.sqlite'))) return [];
  return pluginTerminalReceipts().filter((receipt) => ['launching', 'running', 'exited'].includes(receipt.status)).map((receipt) => receipt.sessionName);
}
export async function launchPluginTerminal(input: { id: string; terminalId: string; revision: string; requestId: string; repo?: string }) {
  const requestId = z.string().uuid().parse(input.requestId).toLowerCase();
  const dir = path.dirname(savedPath(input.id));
  const cwd = input.repo === undefined ? dir : await resolveScope(input.repo);
  if (!cwd) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for this terminal.');
  const claim = lifecycle((database) => {
    const saved = readSaved(input.id);
    if (saved.revision !== input.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
    if (!saved.enabled) throw new ActionPluginError('disabled', 'Plugin is disabled.', 409);
    if (!saved.manifest.supportedPlatforms.includes(process.platform as 'darwin' | 'linux')) throw new ActionPluginError('unsupported_platform', 'This plugin does not support this platform.', 409);
    if ((saved.manifest.workspace === 'registered-project') !== (input.repo !== undefined) || saved.workspaceRoot !== (input.repo === undefined ? null : cwd)) throw new ActionPluginError('invalid_workspace', 'Use the repository selected during review.', 409);
    const terminal = saved.manifest.terminals?.find((item) => item.id === input.terminalId);
    if (!terminal) throw new ActionPluginError('not_found', 'Terminal entrypoint does not exist.', 404);
    const previous = readTerminalReceipts(database).find((receipt) => receipt.id === requestId);
    if (previous) {
      if (previous.pluginId !== input.id || previous.terminalId !== input.terminalId || previous.revision !== input.revision || previous.workspaceRoot !== saved.workspaceRoot) throw new ActionPluginError('conflict', 'Launch request belongs to another terminal.', 409);
      return { receipt: refreshTerminalReceipt(database, previous), created: false };
    }
    if (['0', 'false', 'off', 'no'].includes(process.env.O8_PERSISTENT_TERMINALS?.trim().toLowerCase() ?? '')) throw new ActionPluginError('persistence_disabled', 'Enable persistent terminals before launching a plugin terminal.', 409);
    for (const file of saved.manifest.files) if (sha(safeFile(dir, file.path, 1024 * 1024)) !== file.sha256) throw new ActionPluginError('damaged', 'Plugin file changed after linking.', 409);
    refuseRunning(database, input.id);
    requirePluginTerminalRuntime();
    const state = saved.manifest.state ? provisionActionState({ ...saved, id: input.id }) : null;
    const receipt: PluginTerminalReceipt = {
      id: requestId, pluginId: input.id, terminalId: input.terminalId, revision: input.revision,
      sessionName: `cortex-dash-${requestId.replaceAll('-', '')}`, label: `${saved.manifest.name} / ${terminal.id}`,
      workspaceRoot: saved.workspaceRoot, source: saved.source ?? null, state, actor: 'local-operator',
      startedAt: new Date().toISOString(), finishedAt: null, status: 'launching', exitCode: null, error: null,
    };
    saveTerminalReceipt(database, receipt);
    return { receipt, created: true };
  });
  if (!claim.created) return claim.receipt;
  // The claim is durable before process creation. Holding a separate lifecycle
  // lock across spawn serializes stop/remove/clear without rolling back that
  // recovery record if the host dies before publishing the launch result.
  return lifecycle((database) => {
    const receipt = readTerminalReceipts(database).find((item) => item.id === requestId);
    if (!receipt) throw new ActionPluginError('damaged', 'Terminal launch receipt is missing.', 409);
    if (receipt.status !== 'launching') return receipt;
    try {
      const saved = readSaved(input.id);
      if (!saved.enabled || saved.revision !== input.revision) throw new ActionPluginError('conflict', 'Plugin changed before terminal launch.', 409);
      const terminal = saved.manifest.terminals?.find((item) => item.id === input.terminalId);
      if (!terminal) throw new ActionPluginError('not_found', 'Terminal entrypoint does not exist.', 404);
      for (const file of saved.manifest.files) if (sha(safeFile(dir, file.path, 1024 * 1024)) !== file.sha256) throw new ActionPluginError('damaged', 'Plugin file changed before terminal launch.', 409);
      const current = startPluginTerminal({ sessionName: receipt.sessionName, cwd, entry: path.join(dir, terminal.entry), args: terminal.args, stateDirectory: receipt.state?.directory });
      return saveTerminalReceipt(database, { ...receipt, ...current });
    } catch (error) {
      // A tmux timeout may occur after creation. Keep the durable reservation
      // until inspection proves its state or the operator explicitly stops it.
      return refreshTerminalReceipt(database, saveTerminalReceipt(database, { ...receipt, error: error instanceof ActionPluginError ? error.message : 'Terminal launch outcome is unresolved. Inspect or stop this session before launching again.' }));
    }
  });
}
export function stopPluginTerminalRun(receiptId: string) {
  return lifecycle((database) => {
    const receipt = readTerminalReceipts(database).find((item) => item.id === receiptId.toLowerCase());
    if (!receipt) throw new ActionPluginError('not_found', 'Terminal receipt does not exist.', 404);
    if (receipt.status === 'stopped') return receipt;
    stopPluginTerminal(receipt.sessionName);
    return saveTerminalReceipt(database, { ...receipt, status: 'stopped', finishedAt: receipt.finishedAt ?? new Date().toISOString() });
  });
}
export function listActionPlugins() {
  let dir: string;
  try { dir = root(false); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: [], damaged: [] }; throw error; }
  const installed: Array<Saved & { state?: ActionState }> = []; const damaged: string[] = [];
  for (const id of readdirSync(dir).filter((name) => slug.safeParse(name).success)) {
    try {
      const saved = readSaved(id);
      installed.push({ ...saved, ...(saved.manifest.state ? { state: describeActionState({ ...saved, id }) } : {}) });
    } catch { damaged.push(id); }
  }
  return { installed, damaged };
}
export async function linkActionSource(directory: string, expectedRevision: string, repo?: string, signal?: AbortSignal) {
  const reviewed = await reviewActionSource(directory, repo, signal);
  if (reviewed.manifest.workspace === 'none' && repo !== undefined) throw new ActionPluginError('invalid_workspace', 'This action does not use a repository.');
  if (reviewed.revision !== expectedRevision) throw new ActionPluginError('conflict', 'Source changed since review.', 409);
  return lifecycle(() => {
    const base = root(true);
    const destination = path.join(base, reviewed.manifest.id);
    if (existsSync(destination)) throw new ActionPluginError('already_linked', 'This action plugin is already linked.', 409);
    const stage = path.join(base, `.stage-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    try {
      const currentBytes = safeFile(sourceDir(directory), 'o8-actions.json', 64 * 1024);
      const currentManifest = actionManifestSchema.parse(JSON.parse(currentBytes.toString('utf8')));
      const currentSource = acquiredSource(reviewed.sourceDirectory, currentBytes);
      if (revisionFor(currentManifest, reviewed.workspaceRoot, reviewed.sourceDirectory, currentSource) !== expectedRevision) throw new ActionPluginError('conflict', 'Source changed during linking.', 409);
      for (const file of reviewed.manifest.files) {
        const data = safeFile(sourceDir(directory), file.path, 1024 * 1024);
        if (sha(data) !== file.sha256) throw new ActionPluginError('conflict', 'Source changed during linking.', 409);
        writeFileSync(path.join(stage, file.path), data, { flag: 'wx', mode: 0o700 });
      }
      const linkedAt = new Date().toISOString();
      const saved: Saved = { manifest: reviewed.manifest, revision: reviewed.revision, enabled: true, enabledAt: linkedAt, enabledTriggers: [], triggerEnabledAt: {}, linkedAt, sourceDirectory: reviewed.sourceDirectory, workspaceRoot: reviewed.workspaceRoot, ...(reviewed.source ? { source: reviewed.source } : {}) };
      writeFileSync(path.join(stage, 'installed.json'), JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
      renameSync(stage, destination);
      return saved;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}
export function changeActionPlugin(id: string, revision: string, action: 'enable' | 'disable' | 'remove') {
  return lifecycle((database) => {
    refuseRunning(database, id);
    const saved = readSaved(id);
    if (revision !== saved.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
    const dir = path.dirname(savedPath(id));
    if (action === 'remove') {
      const trash = path.join(root(false), `.removed-${randomUUID()}`);
      renameSync(dir, trash);
      try { rmSync(trash, { recursive: true }); return { cleanupPending: false }; }
      catch { return { cleanupPending: true }; }
    }
    const temporary = path.join(dir, `.save-${randomUUID()}`);
    try {
      const triggerConsentIds = action === 'enable' && !saved.enabled
        ? Object.fromEntries(saved.enabledTriggers.map((triggerId) => [triggerId, randomUUID()])) : saved.triggerConsentIds;
      writeFileSync(temporary, JSON.stringify({ ...saved, triggerConsentIds, enabled: action === 'enable', enabledAt: action === 'enable' ? new Date().toISOString() : null }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path.join(dir, 'installed.json'));
    } finally { rmSync(temporary, { force: true }); }
    return { cleanupPending: false };
  });
}
export function changeActionPluginTrigger(id: string, revision: string, triggerId: string, enabled: boolean) {
  return lifecycle((database) => {
    refuseRunning(database, id);
    const saved = readSaved(id);
    if (revision !== saved.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
    if (!saved.manifest.triggers?.some((trigger) => trigger.id === triggerId)) throw new ActionPluginError('not_found', 'Trigger does not exist.', 404);
    const enabledTriggers = enabled
      ? [...new Set([...saved.enabledTriggers, triggerId])]
      : saved.enabledTriggers.filter((candidate) => candidate !== triggerId);
    const triggerEnabledAt = { ...saved.triggerEnabledAt };
    const triggerConsentIds = { ...saved.triggerConsentIds };
    if (enabled) { triggerEnabledAt[triggerId] ??= new Date().toISOString(); triggerConsentIds[triggerId] ??= randomUUID(); }
    else { delete triggerEnabledAt[triggerId]; delete triggerConsentIds[triggerId]; }
    const dir = path.dirname(savedPath(id));
    const temporary = path.join(dir, `.save-${randomUUID()}`);
    try {
      writeFileSync(temporary, JSON.stringify({ ...saved, enabledTriggers, triggerEnabledAt, triggerConsentIds }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path.join(dir, 'installed.json'));
    } finally { rmSync(temporary, { force: true }); }
    return { enabledTriggers };
  });
}
export function clearActionPluginState(id: string, revision: string) {
  return lifecycle((database) => {
    refuseRunning(database, id);
    const saved = readSaved(id);
    if (saved.revision !== revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
    if (!saved.manifest.state) throw new ActionPluginError('state_not_declared', 'This plugin does not declare persistent state.', 409);
    return clearActionState({ ...saved, id });
  });
}
export async function invokeActionPlugin(id: string, actionId: string, actor = 'local-operator', signal?: AbortSignal, expectedRevision?: string, repo?: string) {
  if (process.platform === 'win32') throw new ActionPluginError('unsupported_platform', 'Executable actions are not available on Windows in this version.', 409);
  const saved = readSaved(id);
  if (expectedRevision !== saved.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
  if (!saved.enabled) throw new ActionPluginError('disabled', 'Action plugin is disabled.', 409);
  if (!saved.manifest.supportedPlatforms.includes(process.platform as 'darwin' | 'linux')) throw new ActionPluginError('unsupported_platform', 'This action plugin does not support this platform.', 409);
  const dir = path.dirname(savedPath(id));
  if (saved.manifest.workspace === 'none' && repo !== undefined) throw new ActionPluginError('invalid_workspace', 'This action does not use a repository.');
  if (saved.manifest.workspace === 'registered-project' && repo === undefined) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for this action.');
  const cwd = repo === undefined ? dir : await resolveScope(repo);
  if (!cwd) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for this action.');
  const receiptId = randomUUID();
  const startedAt = new Date().toISOString();
  const claimed = lifecycle((database) => {
      const fresh = readSaved(id);
      if (expectedRevision !== fresh.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
      if (!fresh.enabled) throw new ActionPluginError('disabled', 'Action plugin is disabled.', 409);
      if (fresh.workspaceRoot !== (repo === undefined ? null : cwd)) throw new ActionPluginError('invalid_workspace', 'Use the repository selected during review.', 409);
      if (!fresh.manifest.supportedPlatforms.includes(process.platform as 'darwin' | 'linux')) throw new ActionPluginError('unsupported_platform', 'This action plugin does not support this platform.', 409);
      const currentAction = fresh.manifest.actions.find((candidate) => candidate.id === actionId);
      if (!currentAction) throw new ActionPluginError('not_found', 'Action does not exist.', 404);
      for (const file of fresh.manifest.files) if (sha(safeFile(dir, file.path, 1024 * 1024)) !== file.sha256) throw new ActionPluginError('damaged', 'Action file changed after linking.', 409);
      refuseRunning(database, id);
      if (fresh.manifest.state && signal?.aborted) throw new ActionPluginError('cancelled', 'Run cancelled before state provisioning.', 409);
      const state = fresh.manifest.state ? provisionActionState({ ...fresh, id }) : undefined;
      database.prepare('INSERT INTO receipts (id, plugin_id, action_id, actor, revision, status, started_at, source_metadata, state_metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(receiptId, id, actionId, actor, fresh.revision, 'running', startedAt, fresh.source ? JSON.stringify(fresh.source) : null, state ? JSON.stringify(state) : null);
      return { saved: fresh, action: currentAction, state };
  });
  return runClaimedAction({ id, actionId, action: claimed.action, saved: claimed.saved, cwd, receiptId, startedAt, actor, signal, state: claimed.state });
}
type ClaimedAction = {
  id: string; actionId: string; action: ActionManifest['actions'][number]; saved: Saved; cwd: string;
  receiptId: string; startedAt: string; actor: string; signal?: AbortSignal;
  input?: string; eventId?: string; triggerId?: string;
  workspaceIdentity?: WorktreeMaterializationIdentity;
  state?: ActionState;
};
async function runClaimedAction(claimed: ClaimedAction) {
  const { id, actionId, action, saved, cwd, receiptId, startedAt, actor, signal, input, eventId, triggerId, workspaceIdentity } = claimed;
  const dir = path.dirname(savedPath(id));
  const result = await new Promise<{ status: string; exitCode: number | null; stdout: string; stderr: string; error: string | null }>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, ['-e', actionRunner, workspaceIdentity ? JSON.stringify(workspaceIdentity) : '', path.join(dir, action.entry), ...action.args], { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: process.env.NODE_ENV ?? 'production', O8_ACTION_TIMEOUT_MS: String(action.timeoutMs), ...(claimed.state ? { O8_PLUGIN_STATE_DIR: claimed.state.directory } : {}) }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], detached: true });
    } catch (error) {
      resolve({ status: 'spawn_error', exitCode: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : 'Could not start action.' });
      return;
    }
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
    let stdout = ''; let stderr = ''; let outputBytes = 0; let retainedBytes = 0; let done = false;
    let cause: 'timeout' | 'cancelled' | 'output_limit' | 'spawn_error' | null = null;
    let failureDetail: string | null = null;
    let actionExitCode: number | null = null;
    const killGroup = () => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
    };
    const stop = (reason: 'timeout' | 'cancelled' | 'output_limit') => {
      cause ??= reason;
      killGroup();
    };
    const timer = setTimeout(() => stop('timeout'), action.timeoutMs);
    const aborted = () => stop('cancelled');
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      const retained = chunk.subarray(0, Math.max(0, 64 * 1024 - retainedBytes));
      retainedBytes += retained.length;
      const value = retained.toString('utf8');
      if (kind === 'stdout') stdout += value;
      else stderr += value;
      if (outputBytes > 64 * 1024) stop('output_limit');
    };
    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const report = message as { type?: string; code?: number | null; message?: string };
      if (report.type === 'complete') actionExitCode = typeof report.code === 'number' ? report.code : null;
      if (report.type === 'spawn_error') { cause = 'spawn_error'; failureDetail = report.message ?? 'Could not start action.'; }
    });
    child.on('error', (error) => { cause = 'spawn_error'; failureDetail = error.message; });
    child.on('exit', () => { killGroup(); });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      killGroup();
      resolve({ status: cause ?? (actionExitCode === 0 ? 'succeeded' : 'failed'), exitCode: actionExitCode ?? code, stdout, stderr, error: failureDetail ?? cause });
    });
  });
  const finishedAt = new Date().toISOString();
  let safeResult: typeof result;
  try {
    const redaction = createBroadcastRedactionContext();
    safeResult = { ...result, stdout: redactBroadcastText(result.stdout, redaction), stderr: redactBroadcastText(result.stderr, redaction), error: result.error ? redactBroadcastText(result.error, redaction) : null };
  } catch {
    safeResult = { ...result, stdout: '[redacted-output]', stderr: '[redacted-output]', error: result.error ? '[redacted-error]' : null };
  }
  const receipt = { id: receiptId, pluginId: id, actionId, actor, actorKind: 'authorization-class' as const, actorIdentity: null, revision: claimed.saved.revision, source: claimed.saved.source ?? null, state: claimed.state ?? null, eventId: eventId ?? null, triggerId: triggerId ?? null, startedAt, finishedAt, ...safeResult };
  const finishDb = db();
  try {
    finishDb.transaction(() => {
      finishDb.prepare('UPDATE receipts SET status = ?, finished_at = ?, exit_code = ?, stdout = ?, stderr = ?, error = ? WHERE id = ?').run(safeResult.status, finishedAt, safeResult.exitCode, safeResult.stdout, safeResult.stderr, safeResult.error, receiptId);
      if (eventId && triggerId) finishDb.prepare('UPDATE trigger_deliveries SET status = ? WHERE event_id = ? AND plugin_id = ? AND trigger_id = ? AND receipt_id = ?').run(safeResult.status, eventId, id, triggerId, receiptId);
    })();
  }
  finally { finishDb.close(); }
  return receipt;
}
const worktreeCreatedPayload = z.object({
  eventId: digest,
  event: z.literal('worktree.created'),
  repositoryPath: z.string().min(1).max(4096),
  worktreeId: z.string().min(1).max(256),
  worktreePath: z.string().min(1).max(4096),
  branch: z.string().min(1).max(1024),
  createdAt: z.string().datetime(),
}).strict();
type WorktreeCreatedPayload = z.infer<typeof worktreeCreatedPayload>;
type DeliveryRow = { event_id: string; plugin_id: string; trigger_id: string; action_id: string; revision: string; payload: string; eligible_at_publish: number; consent_id: string | null };
type TriggerAuthorizations = NonNullable<WorktreeMetaEntry['actionTriggerAuthorizations']>;
/** Snapshot consent before materialization; later settings can never grant an older event. */
export function captureWorktreeCreatedAuthorizations(repositoryPath: string): TriggerAuthorizations {
  try {
    return listActionPlugins().installed.flatMap((saved) => saved.enabled && saved.workspaceRoot === repositoryPath
      ? (saved.manifest.triggers ?? []).flatMap((trigger) => saved.enabledTriggers.includes(trigger.id) && saved.triggerConsentIds?.[trigger.id]
        ? [{ pluginId: saved.manifest.id, revision: saved.revision, triggerId: trigger.id, consentId: saved.triggerConsentIds[trigger.id] }] : []) : []);
  } catch { return []; }
}
/** The worktree manager calls this only after the managed ready metadata is durable. */
export function publishWorktreeCreated(input: Omit<WorktreeCreatedPayload, 'eventId' | 'event'>, authorizations: TriggerAuthorizations = []) {
  const eventId = sha(JSON.stringify({ event: 'worktree.created', repositoryPath: input.repositoryPath, worktreeId: input.worktreeId, createdAt: input.createdAt }));
  const payload = worktreeCreatedPayload.parse({ eventId, event: 'worktree.created', ...input });
  lifecycle((database) => {
    const inserted = database.prepare('INSERT OR IGNORE INTO trigger_events (event_id, payload, created_at) VALUES (?, ?, ?)')
      .run(eventId, JSON.stringify(payload), new Date().toISOString());
    if (!inserted.changes) return;
    for (const saved of listActionPlugins().installed) {
      if (saved.workspaceRoot !== payload.repositoryPath) continue;
      for (const trigger of saved.manifest.triggers ?? []) {
        const authorization = authorizations.find((authorization) =>
          authorization.pluginId === saved.manifest.id && authorization.revision === saved.revision && authorization.triggerId === trigger.id
          && authorization.consentId === saved.triggerConsentIds?.[trigger.id]);
        const eligible = saved.enabled && saved.enabledTriggers.includes(trigger.id) && Boolean(authorization);
        database.prepare('INSERT INTO trigger_deliveries (event_id, plugin_id, trigger_id, action_id, revision, status, eligible_at_publish, consent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(eventId, saved.manifest.id, trigger.id, trigger.actionId, saved.revision, 'pending', eligible ? 1 : 0, authorization?.consentId ?? null);
      }
    }
  });
  void recoverActionPluginTriggers().catch((error) => console.warn('[action-triggers] Delivery failed', { error: String(error) }));
  return eventId;
}
let reconcilePromise: Promise<void> | null = null;
let reconcileRetryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconcileRetry() {
  if (reconcileRetryTimer) return;
  reconcileRetryTimer = setTimeout(() => {
    reconcileRetryTimer = null;
    void reconcileWorktreeCreatedEvents().catch((error) => console.warn('[action-triggers] Event reconciliation failed', { error: String(error) }));
  }, 30_000);
  reconcileRetryTimer.unref();
}
/** Recopy any ready worktree whose metadata commit preceded an unavailable event journal. */
export function reconcileWorktreeCreatedEvents(): Promise<void> {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = reconcilePendingWorktreeEvents().finally(() => { reconcilePromise = null; });
  return reconcilePromise;
}
async function reconcilePendingWorktreeEvents() {
  const [{ listReposFresh }, { readWorktreeMetaSnapshot, sameWorktreeCreation, withWorktreeMetaTransaction }, { resolveWorktreeRootLayout }] = await Promise.all([
    import('@/lib/repos/registry'), import('@/lib/worktree/metadata-store'), import('@/lib/worktree/root-layout'),
  ]);
  let failed = false;
  try {
    for (const repo of await listReposFresh()) {
      try {
        const entries = await readWorktreeMetaSnapshot(repo.localPath);
        for (const entry of Object.values(entries)) {
          if (!entry.actionTriggerEventPending) continue;
          if (entry.claudeManaged || !entry.branchName || !entry.materializationIdentity) {
            failed = true;
            continue;
          }
          try {
            publishWorktreeCreated({
              repositoryPath: realpathSync(repo.localPath),
              worktreeId: entry.id,
              worktreePath: path.join(resolveWorktreeRootLayout(repo.localPath).primaryBase, entry.id),
              branch: entry.branchName,
              createdAt: new Date(entry.createdAt).toISOString(),
            }, entry.actionTriggerAuthorizations ?? []);
            await withWorktreeMetaTransaction(repo.localPath, async (transaction) => {
              const current = (await transaction.readAll())[entry.id];
              if (current?.actionTriggerEventPending && sameWorktreeCreation(current, entry)) await transaction.save(entry.id, { ...current, actionTriggerEventPending: false });
            });
          } catch (error) {
            failed = true;
            console.warn('[action-triggers] Ready worktree event remains pending', { worktreeId: entry.id, error: String(error) });
          }
        }
      } catch (error) {
        failed = true;
        console.warn('[action-triggers] Could not read worktree event markers', { error: String(error) });
      }
    }
  } catch (error) {
    scheduleReconcileRetry();
    throw error;
  }
  if (failed) scheduleReconcileRetry();
}
let drainPromise: Promise<void> | null = null;
let claimedSweepTimer: ReturnType<typeof setTimeout> | null = null;
let busyRetryTimer: ReturnType<typeof setTimeout> | null = null;
let drainRequested = false;
function scheduleBusyRetry() {
  if (busyRetryTimer) return;
  busyRetryTimer = setTimeout(() => {
    busyRetryTimer = null;
    void recoverActionPluginTriggers().catch((error) => console.warn('[action-triggers] Busy retry failed', { error: String(error) }));
  }, 1_000);
  busyRetryTimer.unref();
}
export function recoverActionPluginTriggers(): Promise<void> {
  if (drainPromise) { drainRequested = true; return drainPromise; }
  drainPromise = (async () => {
    do {
      drainRequested = false;
      await drainActionPluginTriggers();
    } while (drainRequested);
  })().finally(() => {
    drainPromise = null;
    if (drainRequested) void recoverActionPluginTriggers().catch((error) => console.warn('[action-triggers] Recovery failed', { error: String(error) }));
  });
  return drainPromise;
}
async function drainActionPluginTriggers() {
  lifecycle((database) => {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    database.prepare("UPDATE receipts SET status = 'interrupted', finished_at = ?, error = 'Host stopped before completion' WHERE event_id IS NOT NULL AND status = 'running' AND started_at < ?")
      .run(new Date().toISOString(), cutoff);
    database.prepare("UPDATE trigger_deliveries SET status = 'interrupted' WHERE status = 'claimed' AND receipt_id IN (SELECT id FROM receipts WHERE status = 'interrupted')").run();
  });
  const database = db();
  let pending: DeliveryRow[];
  try {
    pending = database.prepare("SELECT d.*, e.payload FROM trigger_deliveries d JOIN trigger_events e ON e.event_id = d.event_id WHERE d.status = 'pending' ORDER BY e.created_at, d.plugin_id, d.trigger_id").all() as DeliveryRow[];
  } finally { database.close(); }
  for (const row of pending) await deliverTrigger(row);
  const followupDb = db();
  try {
    const active = followupDb.prepare("SELECT MIN(r.started_at) AS started_at FROM trigger_deliveries d JOIN receipts r ON r.id = d.receipt_id WHERE d.status = 'claimed'")
      .get() as { started_at: string | null };
    if (active.started_at && !claimedSweepTimer) {
      const delay = Math.max(1, 60_001 - (Date.now() - Date.parse(active.started_at)));
      claimedSweepTimer = setTimeout(() => {
        claimedSweepTimer = null;
        void recoverActionPluginTriggers().catch((error) => console.warn('[action-triggers] Recovery failed', { error: String(error) }));
      }, delay);
      claimedSweepTimer.unref();
    }
  } finally { followupDb.close(); }
}
async function deliverTrigger(row: DeliveryRow) {
  const payload = worktreeCreatedPayload.parse(JSON.parse(row.payload));
  const receiptId = randomUUID();
  const startedAt = new Date().toISOString();
  let busy = false;
  const claimed = lifecycle((database) => {
    const current = database.prepare('SELECT status FROM trigger_deliveries WHERE event_id = ? AND plugin_id = ? AND trigger_id = ?')
      .get(row.event_id, row.plugin_id, row.trigger_id) as { status: string } | undefined;
    if (current?.status !== 'pending') return null;
    let saved: Saved | null = null;
    let action: ActionManifest['actions'][number] | null = null;
    let state: ActionState | undefined;
    let problem: string | null = null;
    try {
      saved = readSaved(row.plugin_id);
      if (!row.eligible_at_publish) problem = 'Trigger was not enabled when this worktree was created.';
      else if (saved.revision !== row.revision) problem = 'Plugin revision changed after event publication.';
      else if (!saved.enabled) problem = 'Plugin is disabled.';
      else if (!saved.enabledTriggers.includes(row.trigger_id)) problem = 'Trigger is not enabled.';
      else if (!row.consent_id || saved.triggerConsentIds?.[row.trigger_id] !== row.consent_id) problem = 'Trigger consent changed after this worktree was created.';
      else if (!saved.manifest.triggers?.some((trigger) => trigger.id === row.trigger_id && trigger.event === 'worktree.created' && trigger.actionId === row.action_id)) problem = 'Trigger is missing or changed.';
      else if (process.platform === 'win32' || !saved.manifest.supportedPlatforms.includes(process.platform as 'darwin' | 'linux')) problem = 'Platform is unsupported.';
      else if (saved.workspaceRoot !== payload.repositoryPath) problem = 'Event repository does not match the installed project.';
      else {
        action = saved.manifest.actions.find((candidate) => candidate.id === row.action_id) ?? null;
        if (!action) problem = 'Trigger action is missing.';
        else {
          const dir = path.dirname(savedPath(row.plugin_id));
          for (const file of saved.manifest.files) if (sha(safeFile(dir, file.path, 1024 * 1024)) !== file.sha256) throw new ActionPluginError('damaged', 'Action file changed after linking.', 409);
          refuseRunning(database, row.plugin_id);
          if (saved.manifest.state) state = provisionActionState({ ...saved, id: row.plugin_id });
        }
      }
    } catch (error) {
      if (error instanceof ActionPluginError && error.code === 'busy') { busy = true; return null; }
      problem = error instanceof ActionPluginError ? error.message : 'Action installation is unavailable.';
    }
    const status = problem ? 'skipped' : 'running';
    database.prepare('INSERT INTO receipts (id, plugin_id, action_id, actor, revision, status, started_at, finished_at, error, event_id, trigger_id, source_metadata, state_metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(receiptId, row.plugin_id, row.action_id, 'event-trigger', row.revision, status, startedAt, problem ? startedAt : null, problem, row.event_id, row.trigger_id, saved?.source ? JSON.stringify(saved.source) : null, state ? JSON.stringify(state) : null);
    database.prepare('UPDATE trigger_deliveries SET status = ?, receipt_id = ? WHERE event_id = ? AND plugin_id = ? AND trigger_id = ?')
      .run(problem ? 'skipped' : 'claimed', receiptId, row.event_id, row.plugin_id, row.trigger_id);
    return problem || !saved || !action ? null : { saved, action, state };
  });
  if (!claimed) { if (busy) scheduleBusyRetry(); return; }
  try {
    const resolved = await resolveScope(payload.repositoryPath);
    if (!resolved || resolved !== claimed.saved.workspaceRoot) throw new ActionPluginError('invalid_workspace', 'Event repository is no longer registered.', 409);
    const [{ readWorktreeMetaSnapshot }, { resolveWorktreeRootLayout }, { assertWorktreeMaterializationIdentity }] = await Promise.all([
      import('@/lib/worktree/metadata-store'), import('@/lib/worktree/root-layout'), import('@/lib/worktree/materialization-identity'),
    ]);
    const entry = (await readWorktreeMetaSnapshot(resolved))[payload.worktreeId];
    const expectedPath = path.join(resolveWorktreeRootLayout(resolved).primaryBase, payload.worktreeId);
    if (!entry || entry.claudeManaged || (entry.status !== 'ready' && entry.status !== 'active') || entry.branchName !== payload.branch
      || new Date(entry.createdAt).toISOString() !== payload.createdAt || payload.worktreePath !== expectedPath) {
      throw new ActionPluginError('invalid_workspace', 'Created worktree no longer matches durable managed metadata.', 409);
    }
    const workspaceIdentity = await assertWorktreeMaterializationIdentity(payload.worktreePath, entry.materializationIdentity);
    await runClaimedAction({
      id: row.plugin_id, actionId: row.action_id, action: claimed.action, saved: claimed.saved, cwd: payload.worktreePath,
      receiptId, startedAt, actor: 'event-trigger', input: `${JSON.stringify(payload)}\n`, eventId: row.event_id, triggerId: row.trigger_id, workspaceIdentity, state: claimed.state,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Trigger execution failed.';
    lifecycle((database) => {
      database.prepare("UPDATE receipts SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'")
        .run(new Date().toISOString(), message, receiptId);
      database.prepare("UPDATE trigger_deliveries SET status = 'failed' WHERE event_id = ? AND plugin_id = ? AND trigger_id = ? AND receipt_id = ?")
        .run(row.event_id, row.plugin_id, row.trigger_id, receiptId);
    });
  }
}
export function actionReceipts(id?: string) {
  const database = db();
  try {
    const rows = id ? database.prepare('SELECT * FROM receipts WHERE plugin_id = ? ORDER BY started_at DESC LIMIT 100').all(slug.parse(id)) : database.prepare('SELECT * FROM receipts ORDER BY started_at DESC LIMIT 100').all();
    return rows.map((row) => {
      const { source_metadata: metadata, state_metadata: stateMetadata, ...receipt } = row as Record<string, unknown> & {
        id: string; status: string; event_id?: string | null; trigger_id?: string | null;
      };
      let source: GithubActionSource | null = null;
      let state: ActionState | null = null;
      try { if (typeof metadata === 'string') source = githubSourceSchema.parse(JSON.parse(metadata)); } catch { /* Never present malformed origin metadata as verified source. */ }
      try { if (typeof stateMetadata === 'string') state = actionStateSchema.parse(JSON.parse(stateMetadata)); } catch { /* Malformed historical state metadata is not an approved scope. */ }
      return { ...receipt, eventId: receipt.event_id ?? null, triggerId: receipt.trigger_id ?? null, source, state, actorKind: 'authorization-class' as const, actorIdentity: null };
    });
  }
  finally { database.close(); }
}
