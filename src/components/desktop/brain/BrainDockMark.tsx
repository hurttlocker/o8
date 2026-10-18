'use client';
import { motion } from 'framer-motion';

const left = 'M12 6.4C12 3.2 8.2 2.8 6.8 5.2C4 5.1 2.6 7.8 3.8 9.9C1.6 11.7 2 14.9 4.5 16C4.2 19.2 7.5 21.2 9.9 19.5C10.9 19.6 12 18.7 12 17.1L12 6.4Z';
const right = 'M12 6.4C12 3.2 15.8 2.8 17.2 5.2C20 5.1 21.4 7.8 20.2 9.9C22.4 11.7 22 14.9 19.5 16C19.8 19.2 16.5 21.2 14.1 19.5C13.1 19.6 12 18.7 12 17.1L12 6.4Z';
const lineLeft = 'M12 12C12 12 11 12 10 12C8 12 6 12 4 12C4 12 4 12 4 12C6 12 8 12 10 12C11 12 12 12 12 12L12 12Z';
const lineRight = 'M12 12C12 12 13 12 14 12C16 12 18 12 20 12C20 12 20 12 20 12C18 12 16 12 14 12C13 12 12 12 12 12L12 12Z';

/** The resting line unfolds into the same two hemispheres as the Brain glyph. */
export function BrainDockMark({ revealed, instant }: { revealed: boolean; instant: boolean }) {
  const transition = { duration: instant ? 0 : 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] };
  return <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
    <motion.path initial={false} animate={{ d: revealed ? left : lineLeft }} transition={transition} />
    <motion.path initial={false} animate={{ d: revealed ? right : lineRight }} transition={transition} />
    <motion.path d="M6.8 5.2v2.1l2 1.1M3.8 9.9h2.4l1.3 1.6M4.5 16h2.2l1.4-2M9.9 19.5v-2.4M17.2 5.2v2.1l-2 1.1M20.2 9.9h-2.4l-1.3 1.6M19.5 16h-2.2l-1.4-2M14.1 19.5v-2.4" initial={false} animate={{ opacity: revealed ? 1 : 0 }} transition={transition} />
  </svg>;
}
