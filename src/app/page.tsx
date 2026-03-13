import { CommandCenterShell } from '@/components/command-center-shell';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [initialSnapshot, initialReview] = await Promise.all([
    getRuntimeInventorySnapshot(),
    getWorkspaceReviewSnapshot(),
  ]);

  return <CommandCenterShell initialSnapshot={initialSnapshot} initialReview={initialReview} />;
}
