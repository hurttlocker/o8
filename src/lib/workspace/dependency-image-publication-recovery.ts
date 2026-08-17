import { randomUUID } from 'node:crypto';
import {
  lstat, mkdir, readdir, realpath, rename, rmdir,
} from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import {
  adoptDependencySeedImagePublisher,
  listDependencySeedImages,
  publishDependencySeedImage,
  readDependencySeedImage,
  recordBuiltDependencySeedImage,
  removeUnpublishedDependencySeedImage,
  type DependencySeedImageRecord,
} from './dependency-seed-registry';
import {
  assertExactDependencyFileIdentity,
  exactDependencyFileAt,
  readExactDependencyFile,
  sealExactDependencyFile,
  type ExactDependencyFileAuthority,
} from './dependency-image-file-authority';
import {
  mountedDependencyImages,
  parseDependencyValidationAttachInfo,
  runHdiCommand,
} from './dependency-image-device-authority';
import {
  digestDependencyTree,
  type DependencyImageManifest,
} from './dependency-image-source-authority';
import {
  currentDependencyImageOwner,
  sameDependencyImagePublisher,
  type DependencyImagePublisherAuthority,
} from './dependency-image-publisher-authority';
import { purgeExactDirectory } from './exact-directory-purge';
import type { DependencyImageOptions } from './dependency-image-options';

class InvalidDependencyImageStagingError extends Error {}
class BlockedDependencyImagePublicationError extends Error {}

export interface DependencyImagePublicationRecoveryOutcome {
  recipeKey: string;
  generation: string;
  state: 'ready' | 'retired' | 'blocked';
  note?: string;
}

export interface DependencyImagePublicationRecoveryReceipt {
  inspected: number;
  ready: number;
  retired: number;
  blocked: number;
  complete: boolean;
  outcomes: DependencyImagePublicationRecoveryOutcome[];
}

function registryRoot(options: DependencyImageOptions): string {
  return path.resolve(options.registryRoot ?? path.join(getDataDir(), 'dependency-images'));
}

function expectedPublicationPaths(record: DependencySeedImageRecord, root: string) {
  const stem = `${record.recipeKey}-${record.generation}`;
  const stagingDirectory = path.join(root, 'staging', stem);
  const stagingPath = path.join(stagingDirectory, 'image.dmg');
  return {
    imagePath: path.join(root, 'images', `${stem}.dmg`),
    manifestPath: path.join(root, 'images', `${stem}.manifest.json`),
    stagingDirectory,
    stagingPath,
    stagedManifestPath: `${stagingPath}.manifest.json`,
  };
}

function assertPublicationPaths(record: DependencySeedImageRecord, root: string): void {
  const expected = expectedPublicationPaths(record, root);
  if (record.imagePath !== expected.imagePath
    || record.manifestPath !== expected.manifestPath
    || record.stagingDirectory !== expected.stagingDirectory
    || record.stagingPath !== expected.stagingPath) {
    throw new BlockedDependencyImagePublicationError(
      'Dependency image publication paths differ from the exact registry generation.',
    );
  }
}

async function exactStagingDirectory(
  record: DependencySeedImageRecord,
): Promise<'exact' | 'absent'> {
  let entry;
  try {
    entry = await lstat(record.stagingDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw new BlockedDependencyImagePublicationError(
      `Dependency image staging inventory failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()
    || entry.dev !== record.stagingDevice || entry.ino !== record.stagingInode) {
    throw new BlockedDependencyImagePublicationError(
      'Dependency image staging directory has ambiguous identity.',
    );
  }
  return 'exact';
}

async function exactFileShape(filePath: string): Promise<{ device: number; inode: number }> {
  let entry;
  try {
    entry = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new InvalidDependencyImageStagingError('Dependency image staging is partial.');
    }
    throw new BlockedDependencyImagePublicationError(
      `Dependency image staging file inventory failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw new InvalidDependencyImageStagingError(
      'Dependency image staging contains an unsupported file authority.',
    );
  }
  return { device: entry.dev, inode: entry.ino };
}

function parseStagedManifest(
  bytes: Buffer,
  record: DependencySeedImageRecord,
  image: ExactDependencyFileAuthority,
): DependencyImageManifest {
  let parsed: Partial<DependencyImageManifest>;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as Partial<DependencyImageManifest>;
  } catch {
    throw new InvalidDependencyImageStagingError(
      'Dependency image staged manifest is not valid JSON.',
    );
  }
  const manifest: DependencyImageManifest = {
    version: 1,
    recipeKey: record.recipeKey,
    generation: record.generation,
    treeDigest: record.sourceTreeDigest ?? '',
    imageDigest: image.digest,
  };
  if (Object.keys(parsed).sort().join(',') !== 'generation,imageDigest,recipeKey,treeDigest,version'
    || parsed.version !== manifest.version
    || parsed.recipeKey !== manifest.recipeKey
    || parsed.generation !== manifest.generation
    || parsed.treeDigest !== manifest.treeDigest
    || parsed.imageDigest !== manifest.imageDigest
    || bytes.toString('utf8') !== `${JSON.stringify(manifest)}\n`) {
    throw new InvalidDependencyImageStagingError(
      'Dependency image staged manifest differs from its exact generation.',
    );
  }
  return manifest;
}

async function validateRecoveryImage(
  imagePath: string,
  image: Pick<ExactDependencyFileAuthority, 'device' | 'inode'>,
  treeDigest: string,
  root: string,
): Promise<void> {
  try {
    await runHdiCommand(['verify', imagePath]);
  } catch (error) {
    throw new InvalidDependencyImageStagingError(
      `Dependency image staging failed structural verification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validationMount = path.join(root, `.recover-validate-${randomUUID()}`);
  await mkdir(validationMount, { mode: 0o700 });
  let deviceEntry: string | null = null;
  let failure: unknown = null;
  try {
    const attached = await runHdiCommand([
      'attach', '-readonly', '-nobrowse', '-owners', 'on',
      '-mountpoint', validationMount, '-plist', imagePath,
    ]);
    const validation = await parseDependencyValidationAttachInfo(attached.stdout);
    deviceEntry = validation.deviceEntry;
    if (await realpath(validation.mountPath) !== await realpath(validationMount)) {
      throw new BlockedDependencyImagePublicationError(
        'Dependency image recovery mount did not preserve its exact path.',
      );
    }
    let actualTreeDigest: string;
    try {
      actualTreeDigest = await digestDependencyTree(validationMount);
    } catch (error) {
      throw new BlockedDependencyImagePublicationError(
        `Dependency image recovery tree inventory failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (actualTreeDigest !== treeDigest) {
      throw new InvalidDependencyImageStagingError(
        'Dependency image staging differs from its install-time source tree.',
      );
    }
    let live;
    try {
      live = (await mountedDependencyImages()).find((entry) => entry.deviceEntry === deviceEntry);
    } catch (error) {
      throw new BlockedDependencyImagePublicationError(
        `Dependency image device inventory failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!live || live.imagePath !== path.resolve(imagePath) || live.writable) {
      throw new BlockedDependencyImagePublicationError(
        'Dependency image recovery could not attest its read-only device inventory.',
      );
    }
    await assertExactDependencyFileIdentity(imagePath, image);
  } catch (error) {
    failure = error;
  } finally {
    if (deviceEntry) {
      try {
        await runHdiCommand(['detach', deviceEntry, '-quiet']);
      } catch (error) {
        failure = new BlockedDependencyImagePublicationError(
          `Dependency image recovery detach failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      await rmdir(validationMount);
    } catch (error) {
      failure ??= new BlockedDependencyImagePublicationError(
        `Dependency image recovery mount cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failure) throw failure;
}

async function assertDestinationAbsent(filePath: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new BlockedDependencyImagePublicationError(
      `Dependency image destination inventory failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new BlockedDependencyImagePublicationError(
    'Dependency image destination already names an unreceipted file.',
  );
}

async function finalizeBuiltPublication(
  record: DependencySeedImageRecord,
  publisher: DependencyImagePublisherAuthority,
  root: string,
): Promise<void> {
  if (record.state !== 'built' || record.imageDevice === null || record.imageInode === null
    || !record.imageDigest || record.manifestDevice === null || record.manifestInode === null
    || !record.manifestDigest || !record.sourceTreeDigest) {
    throw new BlockedDependencyImagePublicationError(
      'Built dependency image publication has incomplete durable authority.',
    );
  }
  const expected = expectedPublicationPaths(record, root);
  const imageAuthority = {
    device: record.imageDevice,
    inode: record.imageInode,
    digest: record.imageDigest,
  };
  const manifestAuthority = {
    device: record.manifestDevice,
    inode: record.manifestInode,
    digest: record.manifestDigest,
  };
  const imagePath = await exactDependencyFileAt(
    [record.imagePath, record.stagingPath], imageAuthority,
  );
  const manifestPath = await exactDependencyFileAt(
    [record.manifestPath, expected.stagedManifestPath], manifestAuthority,
  );
  if (!imagePath || !manifestPath) {
    throw new BlockedDependencyImagePublicationError(
      'Built dependency image publication lost an exact artifact inode.',
    );
  }
  if (imagePath === record.stagingPath) {
    await assertDestinationAbsent(record.imagePath);
    await rename(record.stagingPath, record.imagePath);
  }
  if (manifestPath === expected.stagedManifestPath) {
    await assertDestinationAbsent(record.manifestPath);
    await rename(expected.stagedManifestPath, record.manifestPath);
  }
  const manifestBytes = await readExactDependencyFile(record.manifestPath, manifestAuthority);
  parseStagedManifest(manifestBytes, record, imageAuthority);
  await validateRecoveryImage(record.imagePath, imageAuthority, record.sourceTreeDigest, root);
  if (await exactStagingDirectory(record) === 'exact') {
    await purgeExactDirectory(record.stagingDirectory, {
      device: record.stagingDevice,
      inode: record.stagingInode,
    });
  }
  publishDependencySeedImage({
    recipeKey: record.recipeKey,
    generation: record.generation,
    publisherPid: publisher.pid,
    publisherIdentity: publisher.identity,
  });
}

async function recoverBuildingPublication(
  record: DependencySeedImageRecord,
  publisher: DependencyImagePublisherAuthority,
  root: string,
): Promise<void> {
  if (await exactStagingDirectory(record) === 'absent') {
    throw new InvalidDependencyImageStagingError('Dependency image staging is absent.');
  }
  let names: string[];
  try {
    names = (await readdir(record.stagingDirectory)).sort();
  } catch (error) {
    throw new BlockedDependencyImagePublicationError(
      `Dependency image staging inventory failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expected = expectedPublicationPaths(record, root);
  if (names.join('\0') !== ['image.dmg', 'image.dmg.manifest.json'].join('\0')) {
    throw new InvalidDependencyImageStagingError(
      'Dependency image staging is partial or contains unreceipted entries.',
    );
  }
  if (!record.sourceTreeDigest) {
    throw new InvalidDependencyImageStagingError(
      'Dependency image staging has no install-time tree authority.',
    );
  }
  const imageIdentity = await exactFileShape(record.stagingPath);
  const manifestIdentity = await exactFileShape(expected.stagedManifestPath);
  const imageAuthority = await sealExactDependencyFile(record.stagingPath, imageIdentity);
  const manifestAuthority = await sealExactDependencyFile(
    expected.stagedManifestPath,
    manifestIdentity,
  );
  const manifestBytes = await readExactDependencyFile(
    expected.stagedManifestPath,
    manifestAuthority,
  );
  parseStagedManifest(manifestBytes, record, imageAuthority);
  await validateRecoveryImage(
    record.stagingPath,
    imageAuthority,
    record.sourceTreeDigest,
    root,
  );
  await exactStagingDirectory(record);
  const built = recordBuiltDependencySeedImage({
    recipeKey: record.recipeKey,
    generation: record.generation,
    publisherPid: publisher.pid,
    publisherIdentity: publisher.identity,
    imageDevice: imageAuthority.device,
    imageInode: imageAuthority.inode,
    imageDigest: imageAuthority.digest,
    manifestDevice: manifestAuthority.device,
    manifestInode: manifestAuthority.inode,
    manifestDigest: manifestAuthority.digest,
  });
  await finalizeBuiltPublication(built, publisher, root);
}

async function retireInvalidPublication(
  record: DependencySeedImageRecord,
  publisher: DependencyImagePublisherAuthority,
): Promise<void> {
  if (await exactStagingDirectory(record) === 'exact') {
    await purgeExactDirectory(record.stagingDirectory, {
      device: record.stagingDevice,
      inode: record.stagingInode,
    });
  }
  removeUnpublishedDependencySeedImage({
    recipeKey: record.recipeKey,
    generation: record.generation,
    publisherPid: publisher.pid,
    publisherIdentity: publisher.identity,
  });
}

async function claimDeadPublication(
  record: DependencySeedImageRecord,
  publisher: DependencyImagePublisherAuthority,
): Promise<DependencySeedImageRecord | 'blocked' | 'ready' | 'retired'> {
  if (sameDependencyImagePublisher(record, publisher)) return record;
  if (record.publisherPid === null || !isMetadataLockProcessIdentity(record.publisherIdentity)) {
    return 'blocked';
  }
  const owner = await probeMetadataLockProcessIdentity(record.publisherPid);
  if (owner.state === 'unknown') return 'blocked';
  if (owner.state === 'live'
    && sameMetadataLockProcessIdentity(owner.identity, record.publisherIdentity)) {
    const stable = readDependencySeedImage(record.recipeKey);
    return stable?.generation === record.generation
      && stable.state === record.state
      && stable.publisherPid === record.publisherPid
      && stable.publisherIdentity !== null
      && sameMetadataLockProcessIdentity(stable.publisherIdentity, record.publisherIdentity)
      ? 'blocked'
      : claimDeadPublication(stable ?? record, publisher);
  }
  const adopted = adoptDependencySeedImagePublisher({
    recipeKey: record.recipeKey,
    generation: record.generation,
    priorPublisherPid: record.publisherPid,
    priorPublisherIdentity: record.publisherIdentity,
    publisherPid: publisher.pid,
    publisherIdentity: publisher.identity,
  });
  if (adopted) return adopted;
  const current = readDependencySeedImage(record.recipeKey);
  if (!current) return 'retired';
  if (current.state === 'ready') return 'ready';
  return 'blocked';
}

/** Recover publication crashes before any dependency-image lease or workspace reconciliation. */
export async function reconcileDependencyImagePublications(
  options: DependencyImageOptions = {},
): Promise<DependencyImagePublicationRecoveryReceipt> {
  const records = listDependencySeedImages(['building', 'built']);
  const outcomes: DependencyImagePublicationRecoveryOutcome[] = [];
  if (records.length === 0) {
    return { inspected: 0, ready: 0, retired: 0, blocked: 0, complete: true, outcomes };
  }
  const root = registryRoot(options);
  const publisher = await currentDependencyImageOwner();
  for (const snapshot of records) {
    let record = snapshot;
    try {
      assertPublicationPaths(record, root);
      const claim = await claimDeadPublication(record, publisher);
      if (typeof claim === 'string') {
        outcomes.push({
          recipeKey: record.recipeKey,
          generation: record.generation,
          state: claim === 'ready' ? 'ready' : claim === 'retired' ? 'retired' : 'blocked',
          note: claim === 'blocked'
            ? 'Dependency image publication remains owned or its publisher inventory is uncertain.'
            : undefined,
        });
        continue;
      }
      record = claim;
      if (record.state === 'building') {
        await recoverBuildingPublication(record, publisher, root);
      } else {
        await finalizeBuiltPublication(record, publisher, root);
      }
      outcomes.push({ recipeKey: record.recipeKey, generation: record.generation, state: 'ready' });
    } catch (error) {
      if (error instanceof InvalidDependencyImageStagingError) {
        try {
          await retireInvalidPublication(record, publisher);
          outcomes.push({
            recipeKey: record.recipeKey,
            generation: record.generation,
            state: 'retired',
            note: error.message,
          });
          continue;
        } catch (retirementError) {
          error = new BlockedDependencyImagePublicationError(
            `Dependency image invalid staging retirement is blocked: ${retirementError instanceof Error ? retirementError.message : String(retirementError)}`,
          );
        }
      }
      outcomes.push({
        recipeKey: record.recipeKey,
        generation: record.generation,
        state: 'blocked',
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const ready = outcomes.filter((outcome) => outcome.state === 'ready').length;
  const retired = outcomes.filter((outcome) => outcome.state === 'retired').length;
  const blocked = outcomes.filter((outcome) => outcome.state === 'blocked').length;
  return {
    inspected: records.length,
    ready,
    retired,
    blocked,
    complete: blocked === 0,
    outcomes,
  };
}
