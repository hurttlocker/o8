/** Opt-in real-tree benchmark. Never installs dependencies; deletes only its scratch target. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main() {
  const source = process.cwd();
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-dependency-benchmark-')));
  const target = path.join(scratch, 'target');
  Object.assign(process.env, {
    CORTEX_IDE_DATA_DIR: path.join(scratch, 'data'), O8_DATA_DIR: path.join(scratch, 'data'),
    O8_DEPENDENCY_CLONE_PROFILE: '1',
  });
  try {
    execFileSync('git', ['clone', '--local', '--quiet', source, target], { stdio: 'pipe' });
    const { materializeDependencyInstall } = await import('../src/lib/workspace/dependency-materializer');
    const { guardedWorkspaceInvocation, materializationAwareExecFile } = await import('../src/lib/worktree/materialization-execution');
    const { captureWorktreeMaterializationIdentity } = await import('../src/lib/worktree/materialization-identity');
    const identity = await captureWorktreeMaterializationIdentity(target);
    const version = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
    const started = performance.now();
    const result = await materializeDependencyInstall(target, 'npm ci --offline', {
      cloneSourceWorkspace: source, materializationIdentity: identity,
      resolveVersion: async () => version, env: { O8_APFS_DEPENDENCY_IMAGES: '0' },
      run: async (invocation) => {
        if (invocation.args[0] !== 'rebuild' || invocation.args[1] !== '.') {
          throw new Error('Benchmark refuses dependency installation or a non-clone fallback.');
        }
        const guarded = guardedWorkspaceInvocation(invocation.command, invocation.args, identity);
        await materializationAwareExecFile(guarded.command, guarded.args, {
          cwd: target, env: invocation.env, timeout: invocation.timeoutMs,
        });
      },
    });
    const installed = JSON.parse(readFileSync(path.join(source, 'node_modules/.package-lock.json'), 'utf8')) as { packages: Record<string, unknown> };
    console.log('[real-tree-result]', JSON.stringify({
      elapsedMs: Math.round(performance.now() - started), packages: Object.keys(installed.packages).length,
      source: result.receipt.source,
    }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    console.log('[real-tree-cleanup] deleted owned scratch target');
  }
}
void main().catch((error) => { console.error('[dependency-clone-benchmark]', error); process.exitCode = 1; });
