'use client';

import { motion } from 'framer-motion';

function IconGlobeSimple({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color}
      style={{ display: 'block', width: size, height: size, flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm83.13,96H179.56a144.3,144.3,0,0,0-21.35-66.36A84.22,84.22,0,0,1,211.13,116ZM128,207c-9.36-10.81-24.46-33.13-27.45-67h54.94a119.74,119.74,0,0,1-17.11,52.77A108.61,108.61,0,0,1,128,207Zm-27.45-91a119.74,119.74,0,0,1,17.11-52.77A108.61,108.61,0,0,1,128,49c9.36,10.81,24.46,33.13,27.45,67ZM97.79,49.64A144.3,144.3,0,0,0,76.44,116H44.87A84.22,84.22,0,0,1,97.79,49.64ZM44.87,140H76.44a144.3,144.3,0,0,0,21.35,66.36A84.22,84.22,0,0,1,44.87,140Zm113.34,66.36A144.3,144.3,0,0,0,179.56,140h31.57A84.22,84.22,0,0,1,158.21,206.36Z" />
    </svg>
  );
}

export function BrowserHoverButton({
  active,
  onClick,
}: {
  active: boolean;
  url?: string | null | undefined;
  onClick?: () => void;
}) {
  return (
    <span style={{ display: 'inline-flex', position: 'relative' }}>
      <motion.button
        type="button"
        aria-label="Browser"
        title="Browser"
        onClick={onClick}
        initial={false}
        animate="rest"
        whileHover="hover"
        variants={{
          rest: {
            background: 'var(--t-pill-rest-bg, transparent)',
            color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-secondary)',
          },
          hover: {
            background: 'var(--t-hover)',
            color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text)',
          },
        }}
        transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
        style={{
          // Matched to HeaderIconPill — 26 tall, 7px radius, flat hover.
          // Brand-orange icon color when active is the only state indicator.
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 26,
          minWidth: 26,
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 7,
          paddingRight: 7,
          border: 'none',
          borderRadius: 7,
          cursor: 'pointer',
          flexShrink: 0,
          marginTop: -3,
          WebkitTapHighlightColor: 'transparent',
          ['WebkitAppRegion' as string]: 'no-drag',
        }}
      >
        <motion.span
          variants={{
            rest: { opacity: 1 },
            hover: { opacity: 1 },
            active: { opacity: 1 },
          }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
          style={{ display: 'inline-flex' }}
        >
          <IconGlobeSimple size={16} color={active ? 'var(--t-brand-orange, #FF5A1F)' : 'currentColor'} />
        </motion.span>
      </motion.button>
    </span>
  );
}
