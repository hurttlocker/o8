import { notFound } from 'next/navigation';
import { WorkerTranscriptPreview } from './WorkerTranscriptPreview';

export default async function WorkerTranscriptPreviewPage({ searchParams }: { searchParams: Promise<{ fixture?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { fixture } = await searchParams;
  return <WorkerTranscriptPreview selected={fixture} />;
}
