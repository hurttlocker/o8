import { parkLegacyOutput, continueLegacyOutputPark, readLegacyOutputPark, listLegacyOutputParks } from '../src/lib/workspace/legacy-output-parking';
import { parkFailedPrebuild, readFailedPrebuildPark, resumeFailedPrebuild } from '../src/lib/workspace/failed-prebuild-parking';
import { captureWorktreeMaterializationIdentity } from '../src/lib/worktree/materialization-identity';
import { previewParkedOutput, validParkedOutputSelection } from '../src/lib/workspace/parked-output-preview';
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
    retirement: resource.retirement ?? null, disposal: resource.disposal ?? null,
    continuedFrom: resource.continuedFrom ?? null };
}

async function main() {
  const argv = process.argv.slice(2);
  if (Buffer.byteLength(JSON.stringify(argv)) > 16_384) throw new Error('Generated-output arguments exceed their bound.');
  const command = argv.shift(); const values = new Map<string, string>(); const evidencePaths: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!['--workspace', '--resource', '--repository', '--worktree-id', '--intent', '--evidence', '--operation', '--kind'].includes(key)
      || !value?.trim() || (key !== '--evidence' && values.has(key))) throw new Error('Invalid generated-output arguments.');
    if (key === '--evidence') evidencePaths.push(value); else values.set(key, value);
  }
  const resourceId = values.get('--resource'); const workspacePath = values.get('--workspace');
  if (command === 'disposition-preview') {
    const kind = values.get('--kind'); const operation = values.get('--operation');
    if (!validParkedOutputSelection(kind, operation) || values.size !== 2 || evidencePaths.length) {
      throw new Error('Disposition preview requires exactly --kind legacy|failed-prebuild and --operation UUID.');
    }
    process.stdout.write(`${JSON.stringify(previewParkedOutput(kind, operation!))}\n`);
    return;
  }
  if (['park-failed-prebuild', 'resume-failed-prebuild', 'failed-prebuild-status'].includes(command ?? '')) {
    let record;
    if (command === 'park-failed-prebuild') {
      const intent = values.get('--intent');
      if (!resourceId || !intent || values.size !== 2) throw new Error('Failed prebuild parking requires --resource, --intent and --evidence.');
      record = await parkFailedPrebuild({ resourceId, intent, evidencePaths });
    } else {
      const operation = values.get('--operation');
      if (!operation || values.size !== 1 || evidencePaths.length) throw new Error('Select exactly one --operation.');
      record = command === 'failed-prebuild-status' ? readFailedPrebuildPark(operation) : await resumeFailedPrebuild(operation);
    }
    const { entries, ...retention } = record;
    process.stdout.write(`${JSON.stringify({ schema: 'o8/failed-prebuild-cli/v1', ok: true, command,
      retention: { ...retention, entryCount: entries.length, reclaimedBytes: 0 } })}\n`);
    return;
  }
  if (['park-legacy', 'restore-legacy', 'resume-legacy', 'legacy-status'].includes(command ?? '')) {
    const operation = values.get('--operation');
    const intent = values.get('--intent');
    let records;
    if (command === 'park-legacy') {
      if (!workspacePath || !intent || values.size !== 2) throw new Error('Parking requires --workspace, --intent and retained --evidence files.');
      records = [await parkLegacyOutput({ workspacePath, intent, evidencePaths })];
    } else if (command === 'legacy-status' && workspacePath && values.size === 1 && !evidencePaths.length) {
      const workspace = await captureWorktreeMaterializationIdentity(workspacePath);
      records = listLegacyOutputParks(workspace.canonicalPath);
    } else {
      if (!operation || values.size !== 1 || evidencePaths.length) throw new Error('Select exactly one --operation.');
      records = [command === 'legacy-status' ? readLegacyOutputPark(operation)
        : await continueLegacyOutputPark(operation, command === 'restore-legacy')];
    }
    process.stdout.write(`${JSON.stringify({ schema: 'o8/legacy-output-cli/v1', ok: true, command,
      legacy: records.map(({ entries, ...record }) => ({ ...record, entryCount: entries.length, reclaimedBytes: 0 })) })}\n`);
    return;
  }
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
    throw new Error('Use generated-output register, status, adopt, recover, recover-verification, retire, retire-verification, park-legacy, legacy-status, resume-legacy, restore-legacy, park-failed-prebuild, failed-prebuild-status or resume-failed-prebuild.');
  }
  process.stdout.write(`${JSON.stringify({ schema: 'o8/generated-output-cli/v1', ok: true, command,
    resource: project(resource) })}\n`);
}

void main().catch(error => {
  process.stderr.write(`${JSON.stringify({ schema: 'o8/generated-output-cli/v1', ok: false,
    error: { code: 'generated_output_refused', message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
});
