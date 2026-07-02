import DOMPurify from 'dompurify';

/**
 * The single sanitizer boundary for agent-authored HTML/SVG that a surface
 * renders via dangerouslySetInnerHTML. Agent content (repo files, diffs, Brain
 * answers, o8.md) is untrusted; rendering it raw is a same-origin XSS in the
 * operator's authenticated webview (SECURITY_AUDIT_2026-07-02 §CRIT-2).
 *
 * DOMPurify strips <script>, event handlers (on*), and javascript: URLs by
 * default. We additionally forbid the tags that carry the non-obvious vectors:
 *  - <iframe>/<object>/<embed>: a same-origin frame the agent could point at
 *    our API (the confirmed exploit used an agent-supplied iframe sandbox).
 *  - <foreignObject>: smuggles arbitrary HTML/script inside an <svg>.
 *  - SMIL <animate>/<set>/<animateTransform>/<animateMotion>: their onbegin/
 *    onend handlers fire on DOM insertion (the sanitizer-agnostic SVG vector).
 */
const SANITIZE_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  FORBID_TAGS: [
    'script', 'iframe', 'object', 'embed', 'base', 'foreignObject',
    'animate', 'animateTransform', 'animateMotion', 'set',
  ],
  // DOMPurify strips on* already; name the SMIL timing handlers explicitly.
  FORBID_ATTR: ['onbegin', 'onend', 'onrepeat'],
};

/**
 * Sanitize agent HTML/SVG for a dangerouslySetInnerHTML sink. Returns a safe
 * HTML string. On the server (no DOM) returns '' — callers gate the sink behind
 * a mounted flag so the real, sanitized render happens client-side with no
 * hydration mismatch.
 */
export function sanitizeAgentHtml(dirty: string): string {
  if (typeof window === 'undefined') return '';
  return DOMPurify.sanitize(dirty, SANITIZE_CONFIG) as unknown as string;
}
