import { notFound } from 'next/navigation';
import { WorkspaceControlsPreview } from './WorkspaceControlsPreview';

export default function WorkspaceControlsPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <WorkspaceControlsPreview />;
}
