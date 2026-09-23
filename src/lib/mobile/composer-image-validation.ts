/** Shared browser/server guard so an image can never be silently sent as text. */
export interface ComposerImageAttachment {
  dataUri: string;
  name?: string;
}

const IMAGE_DATA_URI = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/]+={0,2})$/i;
const MAX_IMAGES = 8;
const MAX_DATA_URI_LENGTH = 5_000_000;

export function validateComposerImageAttachments(value: unknown): ComposerImageAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) {
    throw new Error('Attach at most 8 images before sending.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Image ${index + 1} is invalid. Reattach it before sending.`);
    }
    const attachment = item as Record<string, unknown>;
    const dataUri = typeof attachment.dataUri === 'string' ? attachment.dataUri : '';
    const match = IMAGE_DATA_URI.exec(dataUri);
    if (!match || dataUri.length >= MAX_DATA_URI_LENGTH) {
      throw new Error(`Image ${index + 1} must be PNG, JPEG, GIF, or WebP and under 5 MB.`);
    }
    try {
      if (btoa(atob(match[2])) !== match[2]) throw new Error('Non-canonical base64');
    } catch {
      throw new Error(`Image ${index + 1} has invalid data. Reattach it before sending.`);
    }
    if (attachment.name !== undefined && typeof attachment.name !== 'string') {
      throw new Error(`Image ${index + 1} has an invalid name. Reattach it before sending.`);
    }
    return {
      dataUri: `data:${match[1].toLowerCase()};base64,${match[2]}`,
      ...(typeof attachment.name === 'string' ? { name: attachment.name.trim().slice(0, 500) } : {}),
    };
  });
}

export function composerBackendSupportsImages(backend: string): boolean {
  return backend === 'codex' || backend === 'claude' || backend === 'fable' || backend === 'collide';
}
