import { notFound } from 'next/navigation';
import { FirstRunPreview } from './FirstRunPreview';

export default function FirstRunPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <FirstRunPreview />;
}
