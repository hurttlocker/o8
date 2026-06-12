/**
 * `o8 browser <verb>` — drive o8's EMBEDDED browser (canvas browser cards /
 * the Browser tab) from a dispatched agent (#1232 phase 1).
 *
 * Verbs:
 *   o8 browser open [url]                      reveal the browser, optionally at a URL
 *   o8 browser read [--selector css]           page text + interactive elements (selectors)
 *   o8 browser click <selector>                click an element (ghost cursor paints in the UI)
 *   o8 browser type <selector> <text…>         type into an input (--submit presses Enter)
 *   o8 browser wait <selector> [--text s]      poll until the selector (and text) resolves
 *
 * Common flags: --surface canvas|panel (default: most recently active).
 * Localhost pages only — the page must be same-origin or proxied; external
 * sites need the engine tier. Every action from a packet worktree records a
 * `browser_acted` lane event for the operator's audit trail.
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printJson, type OutputMode } from '../output.js';
import { resolveLaneFromCwd } from './packet/worktree-resolve.js';

interface BrowserFlags {
  surface: 'canvas' | 'panel' | null;
  selector: string | null;
  text: string | null;
  submit: boolean;
  timeoutMs: number | null;
  maxChars: number | null;
  positional: string[];
}

function parseFlags(rest: string[]): BrowserFlags {
  const flags: BrowserFlags = { surface: null, selector: null, text: null, submit: false, timeoutMs: null, maxChars: null, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--surface') {
      const value = rest[++i];
      if (value === 'canvas' || value === 'panel') flags.surface = value;
    } else if (tok.startsWith('--surface=')) {
      const value = tok.slice('--surface='.length);
      if (value === 'canvas' || value === 'panel') flags.surface = value;
    } else if (tok === '--selector') {
      flags.selector = rest[++i] ?? null;
    } else if (tok.startsWith('--selector=')) {
      flags.selector = tok.slice('--selector='.length);
    } else if (tok === '--text') {
      flags.text = rest[++i] ?? null;
    } else if (tok.startsWith('--text=')) {
      flags.text = tok.slice('--text='.length);
    } else if (tok === '--timeout') {
      flags.timeoutMs = Number.parseInt(rest[++i] ?? '', 10) || null;
    } else if (tok.startsWith('--timeout=')) {
      flags.timeoutMs = Number.parseInt(tok.slice('--timeout='.length), 10) || null;
    } else if (tok === '--max-chars') {
      flags.maxChars = Number.parseInt(rest[++i] ?? '', 10) || null;
    } else if (tok.startsWith('--max-chars=')) {
      flags.maxChars = Number.parseInt(tok.slice('--max-chars='.length), 10) || null;
    } else if (tok === '--submit') {
      flags.submit = true;
    } else if (!tok.startsWith('--')) {
      flags.positional.push(tok);
    }
  }
  return flags;
}

async function packetIdFromCwd(): Promise<string | null> {
  try {
    const resolved = await resolveLaneFromCwd();
    return resolved ? (resolved.packetId ?? resolved.match.packetSlug) : null;
  } catch {
    return null;
  }
}

async function callAgent(verb: string, args: Record<string, unknown>, packetId: string | null): Promise<Record<string, unknown>> {
  const cfg = resolveConfig();
  const res = await apiFetch<Record<string, unknown>>(cfg, '/api/browser/agent', {
    method: 'POST',
    body: { verb, args, ...(packetId ? { packetId } : {}) },
  });
  return (res.data ?? {}) as Record<string, unknown>;
}

export async function runBrowser(mode: OutputMode, verb: string | undefined, rest: string[]): Promise<number> {
  const flags = parseFlags(rest);
  const packetId = await packetIdFromCwd();
  const surface = flags.surface ? { surface: flags.surface } : {};

  switch (verb) {
    case 'open': {
      const url = flags.positional[0] ?? null;
      const data = await callAgent('open', url ? { url } : {}, packetId);
      printJson({ schema: 'o8/cli/browser/v1', verb: 'open', ...data });
      return data.ok === true ? 0 : EXIT.CONFLICT;
    }
    case 'read': {
      const data = await callAgent('read', {
        ...surface,
        ...(flags.selector ? { selector: flags.selector } : {}),
        ...(flags.maxChars ? { maxChars: flags.maxChars } : {}),
      }, packetId);
      printJson({ schema: 'o8/cli/browser/v1', verb: 'read', ...data });
      return data.ok === true ? 0 : EXIT.CONFLICT;
    }
    case 'click': {
      const selector = flags.positional[0] ?? flags.selector;
      if (!selector) throw new CliError('invalid_args', 'o8 browser click requires a CSS selector.', EXIT.INVALID_ARGS);
      const data = await callAgent('click', { selector, ...surface }, packetId);
      printJson({ schema: 'o8/cli/browser/v1', verb: 'click', ...data });
      return data.ok === true ? 0 : EXIT.CONFLICT;
    }
    case 'type': {
      const selector = flags.positional[0] ?? flags.selector;
      const text = flags.text ?? flags.positional.slice(1).join(' ');
      if (!selector || !text) throw new CliError('invalid_args', 'o8 browser type requires a selector and text, e.g. `o8 browser type "#search" hello world`.', EXIT.INVALID_ARGS);
      const data = await callAgent('type', { selector, text, ...(flags.submit ? { submit: true } : {}), ...surface }, packetId);
      printJson({ schema: 'o8/cli/browser/v1', verb: 'type', ...data });
      return data.ok === true ? 0 : EXIT.CONFLICT;
    }
    case 'wait': {
      const selector = flags.positional[0] ?? flags.selector;
      if (!selector) throw new CliError('invalid_args', 'o8 browser wait requires a CSS selector.', EXIT.INVALID_ARGS);
      const timeoutMs = Math.min(25_000, Math.max(500, flags.timeoutMs ?? 10_000));
      const deadline = Date.now() + timeoutMs;
      let last: Record<string, unknown> = { ok: false, error: 'never probed' };
      while (Date.now() < deadline) {
        last = await callAgent('probe', { selector, ...(flags.text ? { text: flags.text } : {}), ...surface }, packetId);
        if (last.ok === true) {
          printJson({ schema: 'o8/cli/browser/v1', verb: 'wait', ...last });
          return 0;
        }
        if (last.pending !== true) break; // hard error — no point polling
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      printJson({ schema: 'o8/cli/browser/v1', verb: 'wait', ok: false, timedOut: last.pending === true, timeoutMs, last });
      return EXIT.CONFLICT;
    }
    default:
      throw new CliError(
        'invalid_args',
        `Unknown browser verb: ${verb ?? '(none)'} — expected open | read | click | type | wait.`,
        EXIT.INVALID_ARGS,
      );
  }
}
