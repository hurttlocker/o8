/**
 * Force ws onto its pure-JS path.
 *
 * The optional native addons can fail under certain build/runtime combinations
 * (notably during Next.js production builds), but the pure-JS fallback is
 * sufficient for Cortex IDE's current usage.
 */

process.env.WS_NO_BUFFER_UTIL ??= '1';
process.env.WS_NO_UTF_8_VALIDATE ??= '1';
