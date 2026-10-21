import { formatHumanSemanticSurface } from './.build/src/presentation/format.js';

// The SDK owns the wire, handshake, tty and flow control.
// This adapter owns only the projection of o8's read-only semantic view.
export function toTspView(sdk, surface) {
  return sdk.ui.col({ key: surface.id }, ...surface.blocks.map(block => {
    const body = block.kind === 'facts'
      ? sdk.ui.kv({ key: 'facts', items: block.facts.map(({ label: k, value: v }) => ({ k, v })) })
      : sdk.ui.table({
          key: 'events',
          cols: [{ id: 'timestamp' }, { id: 'actor' }, { id: 'verb' }],
          rows: block.events.map(event => ({
            id: event.id, cells: { timestamp: event.timestamp, actor: event.actor, verb: event.verb },
          })),
        });
    return sdk.ui.col({ key: block.id }, sdk.ui.text({ key: 'title' }, block.title), body);
  }));
}

function supportsView(caps, surface) {
  const kinds = new Set(['col', 'text']);
  for (const block of surface.blocks) kinds.add(block.kind === 'facts' ? 'kv' : 'table');
  return Array.isArray(caps?.features) && caps.features.includes('flow') &&
    Array.isArray(caps.kinds) && [...kinds].every(kind => caps.kinds.includes(kind));
}

// Same bytes as color(title, 'bold') in cli/src/output.ts; the golden files pin both.
const bold = title => `\x1b[1m${title}\x1b[0m`;

/**
 * Only a terminal that names itself Tern, or an explicit TERN_TSP=1, gets the
 * hello probe. Terminal.app prints an unknown APC as visible text, so probing
 * everywhere would break the plain output there. SSH does not forward
 * TERM_PROGRAM: over SSH from Tern, TSP is opt-in with TERN_TSP=1.
 */
export function mayProbeTern(env) {
  return env.TERN_TSP === '1' || String(env.TERM_PROGRAM ?? '').toLowerCase() === 'tern';
}

/** Static, inert output. Never attach to a worker's stdin or infer an outcome. */
export async function presentSurface(surface, options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const env = options.env ?? process.env;
  const text = formatHumanSemanticSurface(surface, output.isTTY ? bold : undefined);
  const fallback = reason => {
    // An actual stdout failure remains an error; it is not a successful fallback.
    output.write(text);
    return { renderer: 'text', reason };
  };
  if (!input.isTTY || !output.isTTY) return fallback('not-a-tty');
  if (input.isRaw) return fallback('input-already-owned');
  if (env.TERN_TSP === '0' || env.TMUX || env.STY || env.ZELLIJ) return fallback('disabled');
  if (!mayProbeTern(env)) return fallback('not-tern');

  let session, native;
  let sent = false;
  let reason = 'sdk-unavailable';
  try {
    const sdk = await (options.loadSdk ?? (() => import('@stencil-hq/tern')))();
    reason = 'negotiation-failed';
    session = await sdk.connect({
      app: 'o8-lab', features: [], input, output, env,
      timeout: options.timeout ?? 1000,
      bracketedPaste: false, kittyKeyboard: false,
      exitHooks: input === process.stdin && output === process.stdout,
    });
    if (!session) reason = 'no-tsp';
    else if (!supportsView(session.caps, surface)) reason = 'unsupported-capability';
    else {
      reason = 'renderer-failed';
      native = session.open({ id: surface.id, mode: 'flow', listen: false, title: 'o8 packet' });
      native.render(toTspView(sdk, surface));
      await native.close({ keep: true });
      sent = true;
    }
  } catch {
    // Partial native output is removed when the transport still accepts cleanup.
    try { await native?.close({ keep: false }); } catch { /* Best effort on a broken transport. */ }
  } finally {
    try { await session?.close(); }
    catch { sent = false; reason = 'cleanup-failed'; }
  }
  // No text is emitted until the SDK has attempted tty restoration and cleanup.
  return sent ? { renderer: 'tsp' } : fallback(reason);
}
