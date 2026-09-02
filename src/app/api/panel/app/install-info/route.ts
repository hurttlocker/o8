import { NextResponse } from 'next/server';

import { isSelfUpdatableInstall, normalizeInstallPlatform } from '@/lib/app-update/install-target';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What kind of install is running. The bundled server is spawned by the Tauri
 * shell, so it inherits the app process env — including `APPIMAGE`, which the
 * AppImage runtime sets to the path the app was started from. The webview has
 * no way to read either value on its own.
 */
export async function GET() {
  const platform = normalizeInstallPlatform(process.platform);
  const appImagePath = typeof process.env.APPIMAGE === 'string' && process.env.APPIMAGE.trim()
    ? process.env.APPIMAGE.trim()
    : null;
  const info = {
    platform,
    arch: process.arch || null,
    appImagePath,
    updaterSelfUpdatable: null,
  };

  return NextResponse.json(
    { ...info, selfUpdatable: isSelfUpdatableInstall(info) },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
