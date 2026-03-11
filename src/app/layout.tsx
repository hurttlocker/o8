import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cortex IDE',
  description: 'Agent command center prototype for desktop and mobile operators.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
