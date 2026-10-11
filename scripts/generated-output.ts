import { captureWorktreeMaterializationIdentity } from '../src/lib/worktree/materialization-identity';
import { recoverGeneratedOutput } from '../src/lib/workspace/generated-output-recovery';
import { retireGeneratedOutputVerification } from '../src/lib/workspace/generated-output-recovery-retirement';
import { adoptGeneratedOutput, retireGeneratedOutput } from '../src/lib/workspace/generated-output-retirement';
import { generatedOutputOwner, readGeneratedOutputResource, registerGeneratedOutputLocked,
  withGeneratedOutputExclusion, type GeneratedOutputResource } from '../src/lib/workspace/generated-output-state';

function project(resource: GeneratedOutputResource) {
  return { resourceId: resource.resourceId, state: resource.state, origin: resource.origin,
    workspace: resource.workspace, output: resource.output, owner: resource.owner ?? null,
    revision: resource.revision, producer: resource.attempt ?? null,
    bank: resource.bank ? { path: resource.bank.root.canonicalPath, digest: resource.bank.digest,
      entries: resource.bank.entries.length, expandedBytes: resource.bank.expandedBytes,
      compressedBytes: resource.bank.compressedBytes } : null,
    bankCapture: resource.bankCapture ?? null, recovery: resource.recovery ?? null,
    retirement: resource.retirement ?? null };
}

async function main() {
  const argv = process.argv.slice(2);
  if (Buffer.byteLength(JSON.stringify(argv)) > 16_384) throw new Error('Generated-output arguments exceed their bound.');
  const command = argv.shift(); const values = new Map<string, string>(); const evidencePaths: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!['--workspace', '--resource', '--repository', '--worktree-id', '--intent', '--evidence'].includes(key)
      || !value?.trim() || (key !== '--evidence' && values.has(key))) throw new Error('Invalid generated-output arguments.');
    if (key === '--evidence') evidencePaths.push(value); else values.set(key, value);
  }
  const resourceId = values.get('--resource'); const workspacePath = values.get('--workspace');
  let resource: GeneratedOutputResource;
  if (command === 'status' || command === 'recover' || command === 'recover-verification'
    || command === 'retire' || command === 'retire-verification') {
    if (!resourceId || values.size !== 1 || evidencePaths.length) throw new Error('Select exactly one --resource.');
    const current = readGeneratedOutputResource(resourceId);
    if (!current) throw new Error('Generated-output resource was not found.');
    resource = command === 'status' ? current : command === 'recover' || command === 'recover-verification'
      ? await recoverGeneratedOutput(resourceId, command === 'recover-verification' ? 'verification-disposable' : 'recovery')
      : command === 'retire-verification' ? await retireGeneratedOutputVerification(resourceId) : await retireGeneratedOutput(resourceId);
  } else if (command === 'register') {
    if (!workspacePath || values.size !== 1 || evidencePaths.length) throw new Error('Select exactly one --workspace.');
    const workspace = await captureWorktreeMaterializationIdentity(workspacePath);
    const owner = await generatedOutputOwner(workspace);
    resource = await withGeneratedOutputExclusion(workspace, owner, () => registerGeneratedOutputLocked(workspace, owner));
  } else if (command === 'adopt') {
    const repositoryPath = values.get('--repository'); const worktreeId = values.get('--worktree-id'); const intent = values.get('--intent');
    if (!workspacePath || !repositoryPath || !worktreeId || !intent || values.size !== 4) {
      throw new Error('Adoption requires --workspace, --repository, --worktree-id, --intent and --evidence.');
    }
    resource = await adoptGeneratedOutput({ workspacePath, owner: { repositoryPath, worktreeId }, intent, evidencePaths });
  } else {
    throw new Error('Use generated-output register, status, adopt, recover, recover-verification, retire or retire-verification.');
  }
  process.stdout.write(`${JSON.stringify({ schema: 'o8/generated-output-cli/v1', ok: true, command,
    resource: project(resource) })}\n`);
}

void main().catch(error => {
  process.stderr.write(`${JSON.stringify({ schema: 'o8/generated-output-cli/v1', ok: false,
    error: { code: 'generated_output_refused', message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
});
