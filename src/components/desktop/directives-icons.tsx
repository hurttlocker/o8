/**
 * Raw SVG icons for DirectivesView (Tauri compat — no React icon libraries).
 */

interface IconProps {
  size?: number;
  color?: string;
}

export function PlusIcon({ size = 16, color = 'currentColor' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <path d="M128 40v176M40 128h176" stroke={color} strokeWidth="20" strokeLinecap="round" />
    </svg>
  );
}

export function FileTextIcon({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <path
        d="M200 224H56a8 8 0 01-8-8V40a8 8 0 018-8h96l56 56v128a8 8 0 01-8 8z"
        stroke={color} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M152 32v56h56M96 136h64M96 168h64"
        stroke={color} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function TrashIcon({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <path
        d="M216 56H40M104 104v64M152 104v64M200 56v152a8 8 0 01-8 8H64a8 8 0 01-8-8V56M168 56V40a16 16 0 00-16-16h-48a16 16 0 00-16 16v16"
        stroke={color} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function FloppyIcon({ size = 14, color = 'currentColor' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <path
        d="M216 83.31V208a8 8 0 01-8 8H48a8 8 0 01-8-8V48a8 8 0 018-8h124.69a8 8 0 015.66 2.34l35.31 35.31a8 8 0 012.34 5.66z"
        stroke={color} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"
      />
      <path
        d="M80 216v-72a8 8 0 018-8h80a8 8 0 018 8v72M160 72H96"
        stroke={color} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function GlobeIcon({ size = 12, color = 'currentColor' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <circle cx="128" cy="128" r="96" stroke={color} strokeWidth="16" />
      <path
        d="M88 128c0 37.46 16.38 69.89 40 88 23.62-18.11 40-50.54 40-88s-16.38-69.89-40-88C104.38 58.11 88 90.54 88 128zM37.46 96h181.08M37.46 160h181.08"
        stroke={color} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export function FolderIcon({ size = 12, color = 'currentColor' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none">
      <path
        d="M216 72H131.31L104 44.69A8 8 0 0098.34 42H40a8 8 0 00-8 8v156a8 8 0 008 8h176.89A7.11 7.11 0 00224 206.89V80a8 8 0 00-8-8z"
        stroke={color} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}
