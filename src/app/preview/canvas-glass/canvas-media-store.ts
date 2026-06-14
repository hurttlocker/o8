'use client';

/**
 * Canvas media store — IndexedDB blob bucket for video cards (#video-cards).
 *
 * Photos ride the canvas as base64 data-URIs in localStorage, but a video clip
 * is megabytes-to-tens-of-megabytes — it would blow the ~5MB localStorage quota
 * instantly. So the BYTES live here (IndexedDB holds Blobs natively, with a far
 * larger quota), keyed by a media id; the canvas snapshot keeps only that id +
 * the card geometry. On reload we read the Blob back and mint a fresh object URL.
 */

const DB_NAME = 'o8-canvas-media';
const STORE = 'blobs';
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** Stash a Blob under `id`. Resolves false on any IDB failure (private mode,
 *  quota) — the caller still gets a live session card, it just won't persist. */
export async function putMedia(id: string, blob: Blob): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

/** Read a Blob back, or null if it's gone / IDB is unavailable. */
export async function getMedia(id: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise<Blob | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Drop a Blob — called when its card is removed. Best-effort; never throws. */
export async function deleteMedia(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // non-critical
  }
}
