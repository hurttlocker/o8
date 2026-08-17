import {
  beginDependencySeedImageRetirement,
  listDependencySeedLeases,
  readDependencySeedImage,
  removeRetiredDependencySeedImage,
  unlinkExactRetiringDependencySeedFile,
} from './dependency-seed-registry';
import { mountedDependencyImages } from './dependency-image-device-authority';
import { DependencyImageRefusalError } from './dependency-image-source-authority';

export interface DependencyImageRetirementOptions {
  afterStateTransition?: (recipeKey: string) => Promise<void>;
  afterFileRenamed?: (artifact: 'image' | 'manifest', retiredPath: string) => Promise<void>;
}

export async function retireDependencyImage(
  recipeKey: string,
  options: DependencyImageRetirementOptions = {},
): Promise<void> {
  let image = readDependencySeedImage(recipeKey);
  if (!image || (image.state !== 'ready' && image.state !== 'retiring')) return;
  const imagePath = image.imagePath;
  const liveMounts = await mountedDependencyImages();
  if (listDependencySeedLeases(recipeKey).length !== 0
    || liveMounts.some((entry) => entry.imagePath === imagePath)) {
    throw new DependencyImageRefusalError(
      'Dependency image retirement is blocked by a live lease or mount.',
    );
  }
  if (image.state === 'ready') {
    image = beginDependencySeedImageRetirement(recipeKey, image.generation);
  }
  await options.afterStateTransition?.(recipeKey);
  await unlinkExactRetiringDependencySeedFile({
    recipeKey: image.recipeKey,
    generation: image.generation,
    artifact: 'image',
    filePath: image.imagePath,
    device: image.imageDevice,
    inode: image.imageInode,
    digest: image.imageDigest,
    retiredPath: image.imageRetiredPath,
    phase: image.imageRetirementPhase,
    afterRename: async (retiredPath) => options.afterFileRenamed?.('image', retiredPath),
  });
  image = readDependencySeedImage(recipeKey)!;
  await unlinkExactRetiringDependencySeedFile({
    recipeKey: image.recipeKey,
    generation: image.generation,
    artifact: 'manifest',
    filePath: image.manifestPath,
    device: image.manifestDevice,
    inode: image.manifestInode,
    digest: image.manifestDigest,
    retiredPath: image.manifestRetiredPath,
    phase: image.manifestRetirementPhase,
    afterRename: async (retiredPath) => options.afterFileRenamed?.('manifest', retiredPath),
  });
  removeRetiredDependencySeedImage(recipeKey, image.generation);
}
