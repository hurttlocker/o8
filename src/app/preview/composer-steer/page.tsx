import { notFound } from 'next/navigation';
import { ComposerSteerPreview } from './ComposerSteerPreview';

export default function ComposerSteerPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <ComposerSteerPreview />;
}
