/**
 * GitHub OAuth Helpers
 *
 * Fetches user profile from GitHub using an access token.
 * Used after device flow completion to create/update the local user.
 */

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

/**
 * Fetch the authenticated GitHub user's profile.
 */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser | null> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      console.error(`[github] Failed to fetch user: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return {
      id: data.id,
      login: data.login,
      name: data.name,
      email: data.email,
      avatar_url: data.avatar_url,
    };
  } catch (err) {
    console.error('[github] Error fetching user:', err);
    return null;
  }
}

/**
 * Fetch the user's primary email (if profile email is private).
 */
export async function fetchGitHubEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) return null;

    const emails = await res.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find(e => e.primary && e.verified);
    return primary?.email ?? emails.find(e => e.verified)?.email ?? null;
  } catch {
    return null;
  }
}
