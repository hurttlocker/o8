/**
 * Legacy shim — kept so any stragglers importing from `./themes` still
 * resolve. New code should import from `./registry` directly.
 *
 * The two-axis theme system (palette × surface) lives in registry.ts.
 */

import { PALETTES, resolveTheme, type ResolvedTheme } from './registry';

export type ThemeTokens = ResolvedTheme;

/** Resolved themes for both palettes in glass mode (the historical default). */
export const themes: ThemeTokens[] = PALETTES.map((p) => resolveTheme(p, 'glass'));
