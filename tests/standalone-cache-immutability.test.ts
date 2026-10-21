import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from 'next/dist/server/config-shared';
import FileSystemCache from 'next/dist/server/lib/incremental-cache/file-system-cache';
import { nodeFs } from 'next/dist/server/lib/node-fs-methods';
import { getRouteCacheKey } from 'next/dist/server/lib/route-cache-key';
import type { CachedRouteKind, IncrementalCacheKind } from 'next/dist/server/response-cache';
import type { RouteKind } from 'next/dist/server/route-kind';
import nextConfig from '../next.config';

const roots: string[] = [];
// Next's runtime protocol constants have ambient const-enum declarations.
const ownerKind = 'APP_ROUTE' as RouteKind.APP_ROUTE;
const responseKind = 'APP_ROUTE' as CachedRouteKind.APP_ROUTE;
const cacheKind = 'APP_ROUTE' as IncrementalCacheKind.APP_ROUTE;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-standalone-cache-'));
  roots.push(root);
  const serverDistDir = join(root, '.next', 'server');
  mkdirSync(join(serverDistDir, 'app'), { recursive: true });
  const pathname = `/${basename(root)}.png`;
  const owner = { kind: ownerKind, sourceRoute: `${pathname}/route` };
  const key = getRouteCacheKey(pathname, owner);
  const cache = new FileSystemCache({
    fs: nodeFs,
    serverDistDir,
    flushToDisk: nextConfig.experimental?.isrFlushToDisk ?? defaultConfig.experimental.isrFlushToDisk,
    maxMemoryCacheSize: defaultConfig.cacheMaxMemorySize,
    revalidatedTags: [],
    _requestHeaders: {},
  });
  return { root, serverDistDir, owner, pathname, key, cache };
}

function tree(root: string) {
  return (readdirSync(root, { recursive: true }) as string[]).sort().map((path) => {
    const full = join(root, path);
    return [path, statSync(full).isDirectory() ? 'directory'
      : createHash('sha256').update(readFileSync(full)).digest('hex')];
  });
}

describe('standalone response cache preserves the signed package', () => {
  it('keeps repeated icon response updates usable without writing inside the package', async () => {
    const { root, key, cache } = fixture();
    const before = tree(root);
    for (const body of ['first-icon', 'updated-icon', 'last-icon']) {
      await cache.set(key, { kind: responseKind, body: Buffer.from(body),
        headers: { 'content-type': 'image/png' }, status: 200 }, { isFallback: false });
      const cached = await cache.get(key, { kind: cacheKind, isFallback: false });
      expect(cached?.value).toMatchObject({ kind: responseKind, body: Buffer.from(body), status: 200 });
      expect(tree(root)).toEqual(before);
    }
  });

  it('reads a verified compiled icon seed without promoting it into a writable route cache', async () => {
    const { root, serverDistDir, owner, pathname, key, cache } = fixture();
    const body = Buffer.from('compiled-icon');
    writeFileSync(join(serverDistDir, 'app', `${pathname}.body`), body);
    writeFileSync(join(serverDistDir, 'app', `${pathname}.meta`), JSON.stringify({
      headers: { 'content-type': 'image/png' }, status: 200,
      routeCache: { key, owner, isFallback: false },
    }));
    const before = tree(root);
    for (let request = 0; request < 3; request++) {
      const cached = await cache.get(key, { kind: cacheKind, isFallback: false });
      expect(cached?.value).toMatchObject({ kind: responseKind, body, status: 200 });
      expect(tree(root)).toEqual(before);
    }
  });
});
