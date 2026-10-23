import { notFound } from 'next/navigation';
import { TabStripPreview } from './TabStripPreview';

export default function TabStripPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <TabStripPreview />;
}
