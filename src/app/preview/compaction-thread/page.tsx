import { notFound } from 'next/navigation';
import { CompactionThreadPreview } from './CompactionThreadPreview';

export default async function CompactionThreadPreviewPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { view } = await searchParams;
  return <CompactionThreadPreview reloaded={view === 'reloaded'} />;
}
