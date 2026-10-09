import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { assertWorkspaceRetentionReleased } from './retention-holds';
import { assertGeneratedOutputClaimsReleased, generatedOutputOwner, generatedOutputRevision,
  registerGeneratedOutputLocked, saveGeneratedOutputResource, withGeneratedOutputExclusion } from './generated-output-state';

export type GeneratedOutputSpawn = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<number>;

// Pause before the real producer executes, including commands too short to
// probe after ordinary spawn. The parent's durable acknowledgement owns it.
const PRODUCER_START = String.raw`
const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(process.argv[1]);
function parent() {
  const stat = fs.lstatSync('.');
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== input.workspace.device
    || stat.ino !== input.workspace.inode || fs.realpathSync('.') !== input.workspace.canonicalPath) {
    throw new Error('Generated-output producer workspace changed.');
  }
  const output = fs.lstatSync('.next');
  if (!output.isDirectory() || output.isSymbolicLink() || output.dev !== input.output.device
    || output.ino !== input.output.inode || fs.realpathSync('.next') !== input.output.canonicalPath) {
    throw new Error('Generated-output producer child namespace changed.');
  }
}
parent();
const waiting = setTimeout(() => process.exit(78), 30000);
process.once('disconnect', () => process.exit(78));
process.once('message', message => {
  try {
    if (message?.continue !== true) throw new Error('Producer ownership was not acknowledged.');
    parent(); clearTimeout(waiting);
    let command = input.command;
    if (!command.includes(path.sep)) {
      command = (process.env.PATH || '').split(path.delimiter).map(root => path.join(root, command))
        .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
    }
    if (!command) throw new Error('Generated-output producer command is unavailable.');
    process.env.PWD = input.workspace.canonicalPath;
    process.removeAllListeners('disconnect'); process.disconnect();
    process.execve(command, [command, ...input.args], process.env);
  } catch (error) { process.stderr.write(error.message + '\n'); process.exit(78); }
});
process.send({ phase: 'ready' });
`;

/** Ordinary checkouts retain their build behavior until they have a managed owner. */
async function runUnmanagedProducer(input: {
  workspacePath: string;
  operation: (run: GeneratedOutputSpawn) => Promise<number>;
}): Promise<number> {
  const children = new Map<ReturnType<typeof spawn>, Promise<number>>();
  const forward = (signal: NodeJS.Signals) => { for (const child of children.keys()) child.kill(signal); };
  const interrupt = () => forward('SIGINT'); const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const run: GeneratedOutputSpawn = (command, args, env = process.env) => {
    if (children.size) return Promise.reject(new Error('Generated-output child spawns must be serial.'));
    const child = spawn(command, args, { cwd: input.workspacePath, env, stdio: 'inherit' });
    let failure: Error | undefined;
    const closed = new Promise<number>((resolve, reject) => {
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        children.delete(child);
        if (failure) reject(failure); else resolve(code ?? 1);
      });
    });
    children.set(child, closed);
    return closed;
  };
  try {
    const code = await input.operation(run);
    if (children.size) throw new Error('Generated-output operation has an unsettled child.');
    return code;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    forward('SIGTERM');
    await Promise.all([...children.values()].map(closed => closed.catch(() => {})));
  }
}

/** The reservation precedes cache invalidation and every child spawn. Parent death remains held. */
export async function runGeneratedOutputProducer(input: {
  workspacePath: string;
  mode: 'build' | 'dev' | 'start';
  operation: (run: GeneratedOutputSpawn) => Promise<number>;
}): Promise<number> {
  const workspace = await captureWorktreeMaterializationIdentity(input.workspacePath);
  const containingOwner = await generatedOutputOwner(workspace);
  if (!containingOwner) return runUnmanagedProducer(input);
  return withGeneratedOutputExclusion(workspace, containingOwner, async () => {
    const freshOwner = await generatedOutputOwner(workspace);
    if (JSON.stringify(freshOwner) !== JSON.stringify(containingOwner)) throw new Error('Generated-output owner changed before reservation.');
    let resource = await registerGeneratedOutputLocked(workspace, containingOwner);
    assertGeneratedOutputClaimsReleased(workspace);
    if (!resource.output || resource.state === 'active' || resource.state === 'planned'
      || resource.state === 'failed-held' || resource.bankCapture?.state === 'failed-held'
      || resource.bank) throw new Error('Generated output has unresolved producer or retention authority.');
    assertWorkspaceRetentionReleased(resource.output.canonicalPath, resource.output);
    const owner = await probeMetadataLockProcessIdentity(process.pid);
    if (owner.state !== 'live') throw new Error('Generated-output producer identity is unknown.');
    const previousState = resource.state;
    resource = saveGeneratedOutputResource(resource, { state: 'active', revision: await generatedOutputRevision(workspace),
      attempt: { id: randomUUID(), mode: input.mode, ownerPid: process.pid, ownerIdentity: owner.identity, children: [] } });
    let activeChild: ReturnType<typeof spawn> | null = null;
    let activeRun: Promise<number> | null = null;
    let abortRequested = false;
    let requestedStop: NodeJS.Signals | null = null;
    const forward = (signal: NodeJS.Signals) => { requestedStop = signal; activeChild?.kill(signal); };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const runChild: GeneratedOutputSpawn = async (command, args, env = process.env) => {
      if (abortRequested) throw new Error('Generated-output producer admission is closed.');
      if (activeChild) throw new Error('Generated-output child spawns must be serial.');
      if (resource.attempt!.children.length >= 16) throw new Error('Generated-output child count exceeded its bound.');
      await assertWorktreeMaterializationIdentity(resource.output!.canonicalPath, resource.output!);
      if (abortRequested) throw new Error('Generated-output producer admission is closed.');
      const child = spawn(process.execPath, ['-e', PRODUCER_START, JSON.stringify({ workspace, output: resource.output, command, args })], {
        cwd: workspace.canonicalPath, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });
      activeChild = child;
      let spawnError: Error | undefined;
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
        child.once('error', error => { spawnError = error; });
        child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
      });
      const index = resource.attempt!.children.length;
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('message', message => {
            if ((message as { phase?: string })?.phase === 'ready') resolve();
            else reject(new Error('Generated-output producer returned an invalid ready receipt.'));
          });
          void closed.then(() => reject(new Error('Generated-output producer closed before ownership admission.')));
        });
        if (!child.pid) throw new Error('Generated-output child spawn has uncertain ownership.');
        const probe = await probeMetadataLockProcessIdentity(child.pid);
        if (probe.state !== 'live') throw new Error('Generated-output producer birth is unknown.');
        resource = saveGeneratedOutputResource(resource, { attempt: { ...resource.attempt!, children: [...resource.attempt!.children,
          { pid: child.pid, identity: probe.identity, exitCode: null, signal: null, observedClosed: false }] } });
        if (abortRequested) throw new Error('Generated-output producer admission is closed.');
        child.send({ continue: true });
      } catch (error) {
        if (child.connected) child.disconnect();
        await closed;
        activeChild = null;
        throw error;
      }
      const result = await closed;
      if (result.error) throw result.error;
      const children = [...resource.attempt!.children];
      children[index] = { ...children[index], exitCode: result.code, signal: result.signal, observedClosed: true };
      resource = saveGeneratedOutputResource(resource, { attempt: { ...resource.attempt!, children } });
      activeChild = null;
      await assertWorktreeMaterializationIdentity(workspace.canonicalPath, workspace);
      await assertWorktreeMaterializationIdentity(resource.output!.canonicalPath, resource.output!);
      return result.code ?? 1;
    };
    const run: GeneratedOutputSpawn = (command, args, env) => {
      if (activeRun) return Promise.reject(new Error('Generated-output child spawns must be serial.'));
      const pending = runChild(command, args, env);
      activeRun = pending;
      void pending.then(() => { if (activeRun === pending) activeRun = null; },
        () => { if (activeRun === pending) activeRun = null; });
      return pending;
    };
    const settleFailedRun = async () => {
      abortRequested = true;
      const unsettled = activeRun;
      activeChild?.kill('SIGTERM');
      if (unsettled) await unsettled.catch(() => {});
    };
    try {
      const code = await input.operation(run);
      if (activeRun || activeChild || !resource.attempt!.children.length || resource.attempt!.children.some(child => !child.observedClosed)) {
        throw new Error('Generated-output attempt lacks complete observed child exits.');
      }
      const controlledStop = input.mode !== 'build' && requestedStop !== null
        && resource.attempt!.children.every(child => child.identity && child.observedClosed
          && (child.exitCode === 0 || child.signal === requestedStop));
      const success = code === 0 && resource.attempt!.children.every(child => child.identity && child.exitCode === 0 && !child.signal);
      resource = saveGeneratedOutputResource(resource, { state: success
        ? (input.mode === 'start' ? previousState : resource.origin === 'legacy-observation' ? 'legacy-held' : 'succeeded')
        : controlledStop ? previousState : 'failed-held' });
      return success || controlledStop ? 0 : code || 1;
    } catch (error) {
      await settleFailedRun();
      saveGeneratedOutputResource(resource, { state: 'failed-held' });
      throw error;
    } finally {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    }
  });
}
