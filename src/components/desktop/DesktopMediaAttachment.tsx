'use client';

import { useEffect, useState } from 'react';

type MediaSource = {
  path: string;
  status: 'loading' | 'ready' | 'error';
  url?: string;
};

function directSource(path: string) {
  return path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:');
}

const SAFE_RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function useMediaSource(path: string) {
  const [source, setSource] = useState<MediaSource>({ path, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const direct = directSource(path);

  useEffect(() => {
    if (direct) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setSource({ path, status: 'loading' });

    void (async () => {
      try {
        const response = await window.fetch(`/api/mobile/media?path=${encodeURIComponent(path)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Media request failed');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (!SAFE_RASTER_TYPES.has(blob.type.toLowerCase())) throw new Error('Unsupported image type');
        objectUrl = URL.createObjectURL(blob);
        setSource({ path, status: 'ready', url: objectUrl });
      } catch {
        if (!controller.signal.aborted) setSource({ path, status: 'error' });
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, attempt, direct]);

  return {
    source: direct ? { path, status: 'ready' as const, url: path } : source.path === path ? source : { path, status: 'loading' as const },
    retry: () => {
      setSource({ path, status: 'loading' });
      setAttempt((value) => value + 1);
    },
    fail: () => setSource({ path, status: 'error' }),
  };
}

export function DesktopMediaImage({
  path,
  name,
  maxHeight,
}: {
  path: string;
  name: string;
  maxHeight: number;
}) {
  const { source, retry, fail } = useMediaSource(path);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const loaded = source.status === 'ready' && source.url === loadedUrl;
  const savedImageId = /[\\/]orchestrator-images[\\/]([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/.exec(path)?.[1];

  return (
    <div data-o8-saved-image={savedImageId} data-o8-media-path={savedImageId ? path : undefined}
      data-o8-image-source-state={source.status} data-o8-image-url={savedImageId ? source.url : undefined} style={{ display: 'contents' }}>
      {source.status === 'ready' && source.url ? (
        <a href={source.url} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={source.url}
            alt={name}
            loading="lazy"
            onLoad={() => setLoadedUrl(source.url ?? null)}
            onError={fail}
            style={{
              display: 'block',
              visibility: loaded || directSource(path) ? 'visible' : 'hidden',
              width: '100%',
              maxHeight,
              objectFit: 'cover',
            }}
          />
        </a>
      ) : null}
      {source.status === 'loading' || (source.status === 'ready' && !loaded && !directSource(path)) ? (
        <span role="status" style={{ display: 'block', padding: 12, color: 'var(--t-text-muted)', fontSize: 11 }}>
          Loading image…
        </span>
      ) : null}
      {source.status === 'error' ? (
        <button type="button" onClick={retry} style={{ padding: 12, color: 'var(--t-text-muted)', fontSize: 11, background: 'none', border: 'none', cursor: 'pointer' }}>
          Image unavailable · Retry
        </button>
      ) : null}
    </div>
  );
}
