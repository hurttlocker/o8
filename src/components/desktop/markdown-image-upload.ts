const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/i;

const TAURI_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

export interface MarkdownImageAttributes {
  src: string;
  alt: string;
  title: string | null;
}

export interface PendingMarkdownImageUpload {
  placeholder: MarkdownImageAttributes;
  result: Promise<MarkdownImageAttributes>;
}

interface ImageSize {
  width: number;
  height: number;
}

let nonceCounter = 0;

function nextNonce(): string {
  nonceCounter += 1;
  return `${Date.now().toString(36)}${nonceCounter.toString(36)}`;
}

function isUploadableImage(file: File): boolean {
  return IMAGE_MIME.test(file.type);
}

export function imageFilesFromList(list: FileList | File[] | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter(isUploadableImage);
}

// Paste exposes the image on clipboardData.files in modern Chromium, but fall
// back to the items[] API for robustness.
export function imageFilesFromClipboard(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const fromFiles = imageFilesFromList(data.files);
  if (fromFiles.length > 0) return fromFiles;
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && isUploadableImage(file)) files.push(file);
  }
  return files;
}

function altFromName(name: string): string {
  return (name.replace(/\.[^.]+$/, '') || 'image')
    .replace(/[\]\r\n"]/g, '')
    .trim()
    .slice(0, 80) || 'image';
}

function placeholderForName(name: string): MarkdownImageAttributes {
  const safeName = (name || 'image').replace(/[\]\r\n]/g, '').slice(0, 60);
  return {
    src: `#o8-upload-${nextNonce()}`,
    alt: `Uploading ${safeName}…`,
    title: null,
  };
}

export function buildImageMarkdown(image: MarkdownImageAttributes): string {
  const title = image.title ? ` "${image.title}"` : '';
  return `![${image.alt}](${image.src}${title})`;
}

async function readImageSize(file: File): Promise<ImageSize | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      if (size.width > 0 && size.height > 0) return size;
    } catch {
      /* fall through */
    }
  }
  if (typeof Image === 'undefined') return null;
  try {
    const url = URL.createObjectURL(file);
    const size = await new Promise<ImageSize | null>((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve(null);
      image.src = url;
    });
    URL.revokeObjectURL(url);
    return size && size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

async function uploadImageFile(repoPath: string, file: File): Promise<string> {
  const response = await fetch(`/api/repo-spec/asset?repoPath=${encodeURIComponent(repoPath)}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'x-filename': encodeURIComponent(file.name || 'image'),
    },
    body: file,
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    relPath?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || !data?.ok || typeof data.relPath !== 'string') {
    throw new Error(
      typeof data?.error === 'string' ? data.error : `upload failed (${response.status})`,
    );
  }
  return data.relPath;
}

async function uploadImagePath(repoPath: string, srcPath: string): Promise<string> {
  const url = `/api/repo-spec/asset?repoPath=${encodeURIComponent(repoPath)}&srcPath=${encodeURIComponent(srcPath)}`;
  const response = await fetch(url, { method: 'POST' });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    relPath?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || !data?.ok || typeof data.relPath !== 'string') {
    throw new Error(
      typeof data?.error === 'string' ? data.error : `upload failed (${response.status})`,
    );
  }
  return data.relPath;
}

export function createImageFileUploads(
  repoPath: string,
  files: File[],
): PendingMarkdownImageUpload[] {
  return imageFilesFromList(files).map((file) => ({
    placeholder: placeholderForName(file.name),
    result: Promise.all([uploadImageFile(repoPath, file), readImageSize(file)])
      .then(([src, size]) => ({
        src,
        alt: altFromName(file.name),
        title: size ? `${size.width}x${size.height}` : null,
      })),
  }));
}

export function createImagePathUploads(
  repoPath: string,
  paths: string[],
): PendingMarkdownImageUpload[] {
  return paths.filter((srcPath) => {
    const dot = srcPath.lastIndexOf('.');
    return dot >= 0 && TAURI_IMAGE_EXTS.has(srcPath.slice(dot).toLowerCase());
  }).map((srcPath) => {
    const baseName = (srcPath.split('/').pop() || 'image')
      .replace(/[\]\r\n]/g, '')
      .slice(0, 60);
    return {
      placeholder: placeholderForName(baseName),
      result: uploadImagePath(repoPath, srcPath).then((src) => ({
        src,
        alt: altFromName(baseName),
        title: null,
      })),
    };
  });
}
