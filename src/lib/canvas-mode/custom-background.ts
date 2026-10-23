'use client';

export type CanvasImageMode = 'photo' | 'ascii' | 'dither';
export interface CustomCanvasBackgroundSettings {
  dataUrl: string;
  name: string;
  previousBackdrop: string;
  mode: CanvasImageMode;
}

export const MAX_CANVAS_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DATA_URL_CHARS = 2_000_000;
const RASTER_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Only embedded raster bytes are retained. A saved URL can never load a remote image. */
export function readCustomCanvasBackground(value: unknown, builtIns: readonly string[]): CustomCanvasBackgroundSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<CustomCanvasBackgroundSettings>;
  if (typeof candidate.dataUrl !== 'string' || candidate.dataUrl.length > MAX_DATA_URL_CHARS
    || !RASTER_DATA_URL.test(candidate.dataUrl)) return undefined;
  return {
    dataUrl: candidate.dataUrl,
    name: typeof candidate.name === 'string' ? candidate.name.slice(0, 120) : 'Custom image',
    previousBackdrop: builtIns.includes(candidate.previousBackdrop ?? '') ? candidate.previousBackdrop! : 'none',
    mode: candidate.mode === 'ascii' || candidate.mode === 'dither' ? candidate.mode : 'photo',
  };
}

/** Decode locally, bound the pixel count, and flatten to raster bytes before persistence. */
export async function prepareCanvasImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > MAX_CANVAS_IMAGE_BYTES) throw new Error('Choose an image smaller than 5 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => { throw new Error('This image could not be read. Choose another image.'); });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no pixels.');
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing is unavailable.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    if (dataUrl.length > MAX_DATA_URL_CHARS) throw new Error('This image is too detailed to save. Choose a smaller image.');
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** All variants use the same local raster, without animation or further requests. */
export function paintCanvasImage(canvas: HTMLCanvasElement, image: HTMLImageElement, mode: CanvasImageMode): void {
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image rendering is unavailable.');
  context.drawImage(image, 0, 0);
  if (mode === 'photo') return;
  if (mode === 'ascii') {
    const sample = document.createElement('canvas');
    sample.width = Math.min(120, canvas.width);
    sample.height = Math.max(1, Math.round(sample.width * canvas.height / canvas.width / 2));
    const sampler = sample.getContext('2d')!;
    sampler.drawImage(image, 0, 0, sample.width, sample.height);
    const pixels = sampler.getImageData(0, 0, sample.width, sample.height).data;
    context.fillStyle = '#000000'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    const cell = canvas.width / sample.width;
    context.font = `${cell * 1.7}px monospace`;
    context.textBaseline = 'top';
    const ramp = ' .:-=+*#%@';
    for (let y = 0; y < sample.height; y++) for (let x = 0; x < sample.width; x++) {
      const offset = (y * sample.width + x) * 4;
      const gray = pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
      context.fillText(ramp[Math.round(gray / 255 * (ramp.length - 1))], x * cell, y * cell * 2);
    }
    return;
  }
  // Ordered Bayer dithering is deterministic and keeps memory bounded to one frame.
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const frame = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const i = (y * canvas.width + x) * 4;
    const gray = frame.data[i] * .2126 + frame.data[i + 1] * .7152 + frame.data[i + 2] * .0722;
    const value = gray > (bayer[(y % 4) * 4 + x % 4] + .5) * 16 ? 255 : 0;
    frame.data[i] = value; frame.data[i + 1] = value; frame.data[i + 2] = value;
  }
  context.putImageData(frame, 0, 0);
}
