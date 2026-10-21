import { highResolutionAvatarUrl } from '@/lib/auth/avatar-url';

export interface ClerkIdentitySource {
  imageUrl?: string | null;
  primaryEmailAddress?: { emailAddress?: string | null } | null;
  externalAccounts?: ReadonlyArray<{ provider?: unknown; emailAddress?: string | null; imageUrl?: string | null }> | null;
}

/**
 * The signed-in account's current photo and email. Clerk copies the image and
 * primary email at sign-up and does not follow later changes on the linked
 * GitHub account, so that account's own values win. The Clerk values are the
 * fallback when no GitHub account is linked or it carries no image or email.
 */
export function accountIdentity(user: ClerkIdentitySource): { email: string | null; avatarUrl: string | null } {
  const github = user.externalAccounts?.find((account) => String(account.provider).includes('github'));
  return {
    email: github?.emailAddress || user.primaryEmailAddress?.emailAddress || null,
    avatarUrl: highResolutionAvatarUrl(github?.imageUrl || user.imageUrl),
  };
}
