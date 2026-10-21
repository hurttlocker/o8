import { registerCustomCSSVariableTheme } from '@pierre/diffs';

registerCustomCSSVariableTheme('o8-pr-code', {
  foreground: 'var(--t-text)', background: 'var(--t-canvas-bg)',
  'token-keyword': 'var(--t-terminal-ansi-cyan)', 'token-function': 'var(--t-terminal-ansi-blue)',
  'token-string': 'var(--t-terminal-ansi-green)', 'token-string-expression': 'var(--t-terminal-ansi-green)',
  'token-comment': 'var(--t-text-muted)', 'token-constant': 'var(--t-terminal-ansi-yellow)',
  'token-parameter': 'var(--t-text)', 'token-punctuation': 'var(--t-text-secondary)',
  'token-link': 'var(--t-accent)', 'token-inserted': 'var(--t-success)',
  'token-deleted': 'var(--t-danger)', 'token-changed': 'var(--t-terminal-ansi-yellow)',
}, false);
