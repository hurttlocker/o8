import { CommandCenterShell } from '@/components/command-center-shell';
import { getOpenClawFleetSnapshot } from '@/lib/openclaw/fleet';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [initialSnapshot, initialReview] = await Promise.all([
    getOpenClawFleetSnapshot(),
    getWorkspaceReviewSnapshot(),
  ]);

  return <CommandCenterShell initialSnapshot={initialSnapshot} initialReview={initialReview} />;
}
