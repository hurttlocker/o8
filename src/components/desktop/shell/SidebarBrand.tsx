import Image from 'next/image';

export function SidebarBrand() {
  return <span data-sidebar-brand style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0,
    pointerEvents: 'none', userSelect: 'none' }}>
    <Image src="/logos/o8-desktop.png" alt="o8" width={24} height={24} unoptimized
      style={{ display: 'block', objectFit: 'contain' }} />
  </span>;
}
