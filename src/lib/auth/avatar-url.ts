const GITHUB_AVATAR_SIZE = 128;

export function highResolutionAvatarUrl(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;

  try {
    const url = new URL(avatarUrl);
    if (url.hostname === 'avatars.githubusercontent.com' || url.hostname.endsWith('.githubusercontent.com')) {
      url.searchParams.set('s', String(GITHUB_AVATAR_SIZE));
      return url.toString();
    }
  } catch {
    return avatarUrl;
  }

  return avatarUrl;
}
