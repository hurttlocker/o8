import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

/**
 * GET /api/panel/github-status
 *
 * Returns GitHub connection status by shelling out to `gh` CLI.
 * Shows authenticated accounts, scopes, and accessible repos.
 */

function execQuiet(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    }).trim();
  } catch {
    return '';
  }
}

interface GitHubAccount {
  login: string;
  name: string;
  avatarUrl: string;
  active: boolean;
  scopes: string[];
  protocol: string;
}

interface GitHubRepo {
  nameWithOwner: string;
  isPrivate: boolean;
  updatedAt: string;
}

export async function GET() {
  try {
    // Parse gh auth status
    const authRaw = execQuiet('gh auth status 2>&1');
    if (!authRaw) {
      return NextResponse.json({ connected: false, accounts: [], repos: [] });
    }

    // Parse accounts from auth status output
    const accounts: GitHubAccount[] = [];
    const accountBlocks = authRaw.split(/(?=✓ Logged in to)/);

    for (const block of accountBlocks) {
      const loginMatch = block.match(/account (\S+)/);
      if (!loginMatch) continue;

      const login = loginMatch[1];
      const active = block.includes('Active account: true');
      const protocolMatch = block.match(/Git operations protocol: (\S+)/);
      const scopeLineMatch = block.match(/Token scopes: (.+)/);

      const scopes = scopeLineMatch
        ? scopeLineMatch[1].split(',').map((s: string) => s.replace(/[' ]/g, '').trim()).filter(Boolean)
        : [];

      // Get user details from API (only for active account)
      let name = '';
      let avatarUrl = '';
      if (active) {
        const userJson = execQuiet(`gh api user --jq '{name: .name, avatar_url: .avatar_url}' 2>/dev/null`);
        if (userJson) {
          try {
            const user = JSON.parse(userJson);
            name = user.name || '';
            avatarUrl = user.avatar_url || '';
          } catch {
            // ignore parse errors
          }
        }
      } else {
        // For inactive accounts, try to get avatar from the login
        avatarUrl = `https://github.com/${login}.png?size=72`;
      }

      accounts.push({
        login,
        name,
        avatarUrl,
        active,
        scopes,
        protocol: protocolMatch?.[1] || 'https',
      });
    }

    // Get repos
    const reposJson = execQuiet(
      'gh repo list --limit 15 --json nameWithOwner,isPrivate,updatedAt 2>/dev/null'
    );
    let repos: GitHubRepo[] = [];
    if (reposJson) {
      try {
        const parsed = JSON.parse(reposJson);
        repos = parsed.map((r: { nameWithOwner: string; isPrivate: boolean; updatedAt: string }) => ({
          nameWithOwner: r.nameWithOwner,
          isPrivate: r.isPrivate,
          updatedAt: r.updatedAt?.slice(0, 10) || '',
        }));
      } catch {
        // ignore parse errors
      }
    }

    return NextResponse.json({
      connected: accounts.length > 0,
      deviceFlowEnabled: Boolean(process.env.GITHUB_OAUTH_CLIENT_ID?.trim()),
      accounts,
      repos,
    });
  } catch {
    return NextResponse.json({ connected: false, deviceFlowEnabled: false, accounts: [], repos: [] }, { status: 500 });
  }
}
