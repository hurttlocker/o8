import { notFound } from 'next/navigation';
import { WorkerPanePreview } from './WorkerPanePreview';

export default function WorkerPanePreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <WorkerPanePreview />;
}
