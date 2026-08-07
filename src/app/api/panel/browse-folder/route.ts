export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

/**
 * POST /api/panel/browse-folder
 * Opens a native folder picker dialog (macOS Finder via osascript).
 * Returns { path: "/selected/folder" } or { path: null } if cancelled.
 */
export async function POST() {
  try {
    const script = `
      tell application "System Events"
        activate
        set theFolder to choose folder with prompt "Select a project folder"
        return POSIX path of theFolder
      end tell
    `;

    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 60000, // 60s to give user time to browse
    }).trim();

    // Remove trailing slash if present
    const cleanPath = result.endsWith('/') ? result.slice(0, -1) : result;

    return NextResponse.json({ path: cleanPath });
  } catch {
    // User cancelled or osascript failed
    return NextResponse.json({ path: null });
  }
}
