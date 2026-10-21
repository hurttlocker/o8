import { notFound } from 'next/navigation';
import { SubagentsPreview } from './SubagentsPreview';

export default function SubagentsPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <SubagentsPreview />;
}
