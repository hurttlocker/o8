"use client";

import { motion } from "framer-motion";

type RainwaterLogoProps = {
  size?: number;
  color?: string;
  className?: string;
};

/**
 * Animated Rainwater logo — falling droplets with shimmer and ripple.
 * Pure SVG + framer-motion. No images.
 *
 * Ported from PLP (pretty-little-plays) for Cortex IDE / Rainwater IDE branding exploration.
 */
export function RainwaterLogo({
  size = 48,
  color = "currentColor",
  className,
}: RainwaterLogoProps) {
  return (
    <motion.svg
      viewBox="0 0 100 120"
      width={size}
      height={size * 1.2}
      fill="none"
      className={className}
      aria-label="Rainwater"
    >
      {/* Droplet 1 — top, smallest, falls first */}
      <motion.path
        d="M50 8 C50 8 42 22 42 28 C42 32.4 45.6 36 50 36 C54.4 36 58 32.4 58 28 C58 22 50 8 50 8Z"
        fill={color}
        initial={{ opacity: 0, y: -8 }}
        animate={{
          opacity: [0, 1, 1, 0.3, 1],
          y: [-8, 0, 0, 2, 0],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
          times: [0, 0.15, 0.5, 0.75, 1],
        }}
      />

      {/* Droplet 2 — middle left */}
      <motion.path
        d="M32 38 C32 38 24 52 24 58 C24 62.4 27.6 66 32 66 C36.4 66 40 62.4 40 58 C40 52 32 38 32 38Z"
        fill={color}
        initial={{ opacity: 0, y: -6 }}
        animate={{
          opacity: [0, 0.6, 1, 1, 0.5, 1],
          y: [-6, -2, 0, 0, 1, 0],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.3,
          times: [0, 0.1, 0.2, 0.5, 0.8, 1],
        }}
      />

      {/* Droplet 3 — middle right */}
      <motion.path
        d="M68 38 C68 38 60 52 60 58 C60 62.4 63.6 66 68 66 C72.4 66 76 62.4 76 58 C76 52 68 38 68 38Z"
        fill={color}
        initial={{ opacity: 0, y: -6 }}
        animate={{
          opacity: [0, 0.5, 1, 1, 0.4, 1],
          y: [-6, -3, 0, 0, 1.5, 0],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.6,
          times: [0, 0.1, 0.25, 0.5, 0.8, 1],
        }}
      />

      {/* Droplet 4 — bottom center, largest, impact droplet */}
      <motion.path
        d="M50 58 C50 58 38 78 38 86 C38 92.6 43.4 98 50 98 C56.6 98 62 92.6 62 86 C62 78 50 58 50 58Z"
        fill={color}
        initial={{ opacity: 0.8 }}
        animate={{
          opacity: [0.8, 1, 1, 0.6, 1],
          scale: [0.97, 1, 1.02, 1, 0.97],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.9,
          times: [0, 0.2, 0.5, 0.8, 1],
        }}
      />

      {/* Ripple 1 — outer */}
      <motion.ellipse
        cx={50}
        cy={108}
        rx={24}
        ry={4}
        stroke={color}
        strokeWidth={1.5}
        fill="none"
        initial={{ opacity: 0, scaleX: 0.5 }}
        animate={{
          opacity: [0, 0.3, 0.15, 0],
          scaleX: [0.5, 1, 1.2, 1.4],
        }}
        transition={{
          duration: 2.5,
          repeat: Infinity,
          ease: "easeOut",
          delay: 1.2,
        }}
      />

      {/* Ripple 2 — inner */}
      <motion.ellipse
        cx={50}
        cy={108}
        rx={14}
        ry={3}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
        initial={{ opacity: 0, scaleX: 0.6 }}
        animate={{
          opacity: [0, 0.4, 0.2, 0],
          scaleX: [0.6, 1, 1.15, 1.3],
        }}
        transition={{
          duration: 2,
          repeat: Infinity,
          ease: "easeOut",
          delay: 1.0,
        }}
      />

      {/* Shimmer highlight on the large droplet */}
      <motion.ellipse
        cx={46}
        cy={80}
        rx={3}
        ry={6}
        fill="white"
        initial={{ opacity: 0 }}
        animate={{
          opacity: [0, 0.35, 0, 0.2, 0],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 1.5,
          times: [0, 0.3, 0.5, 0.7, 1],
        }}
      />
    </motion.svg>
  );
}
