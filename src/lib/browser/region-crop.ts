/**
 * Crop a region out of a base64 PNG in the browser — used by Design Mode DRAW
 * (Cursor parity, 2026-07-12) for two things:
 *
 *  1. The SEND payload crop: the dashboard receives the full native-window
 *     screenshot (captured fresh at send — Q's law) and also persists a crop of
 *     the stroke bounds so the agent gets exactly what was circled.
 *  2. The composer THUMBNAIL: NativeBrowserSurface captures the live window
 *     while the composer is open and crops a small preview to inject.
 *
 * The screenshot is the native window's backing store (devicePixelRatio-scaled),
 * but the draw rect is in the page's CSS px. We recover the scale empirically
 * from the image's natural pixel size ÷ the page viewport reported alongside the
 * draw — no devicePixelRatio guessing. Runs client-side only (Image + canvas).
 */

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CropViewport {
  width: number;
  height: number;
}

export interface CropOptions {
  /** CSS px of breathing room added around the stroke bounds (default 8). */
  pad?: number;
  /** Downscale the crop so its height is at most this many device px (thumbnail). */
  maxHeight?: number;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    } catch {
      resolve(null);
    }
  });
}

/**
 * Returns the cropped region as bare base64 PNG (no `data:` prefix), or null on
 * any failure (image decode, empty rect, no canvas). Never throws.
 */
export async function cropRegionBase64(
  base64Png: string,
  rect: CropRect,
  viewport: CropViewport | null,
  opts: CropOptions = {},
): Promise<string | null> {
  if (typeof window === 'undefined' || !base64Png) return null;
  try {
    const img = await loadImage(`data:image/png;base64,${base64Png}`);
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;

    // Scale CSS px → screenshot px from the viewport the draw was captured in.
    // Fall back to 1:1 when no viewport was reported (best-effort).
    const scaleX = viewport && viewport.width > 0 ? img.naturalWidth / viewport.width : 1;
    const scaleY = viewport && viewport.height > 0 ? img.naturalHeight / viewport.height : 1;
    const pad = opts.pad ?? 8;

    let sx = (rect.left - pad) * scaleX;
    let sy = (rect.top - pad) * scaleY;
    let sw = (rect.width + pad * 2) * scaleX;
    let sh = (rect.height + pad * 2) * scaleY;

    // Clamp to the image bounds.
    sx = Math.max(0, Math.min(sx, img.naturalWidth - 1));
    sy = Math.max(0, Math.min(sy, img.naturalHeight - 1));
    sw = Math.max(1, Math.min(sw, img.naturalWidth - sx));
    sh = Math.max(1, Math.min(sh, img.naturalHeight - sy));

    // Optional downscale (thumbnail): cap output height, keep aspect.
    let outW = sw;
    let outH = sh;
    if (opts.maxHeight && sh > opts.maxHeight) {
      const ratio = opts.maxHeight / sh;
      outH = opts.maxHeight;
      outW = Math.max(1, Math.round(sw * ratio));
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(outW);
    canvas.height = Math.round(outH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
    const dataUri = canvas.toDataURL('image/png');
    const comma = dataUri.indexOf(',');
    return comma >= 0 ? dataUri.slice(comma + 1) : null;
  } catch {
    return null;
  }
}
