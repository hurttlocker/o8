/**
 * `o8 packet capture` — agent-facing visual proof capture (#1147 phase 1).
 *
 * Screenshots the agent's own running app (the localhost server it started
 * via `o8 run`) through o8's in-house headless browser engine
 * (/api/browser/engine/capture, #1648 — no external tools on PATH), then
 * uploads the bytes to /api/panel/artifacts so the proof rides back to the
 * orchestrator in the packet status payload and surfaces as a before/after
 * strip in o8.
 *
 *   o8 packet capture --url http://localhost:3000/login --label "login bug" --before
 *   o8 packet capture --url http://localhost:3000/login --label "fixed" --after \
 *       --wait-for "[data-testid=dashboard]" --settle 400
 *
 * Capture timing is the whole ballgame — `--wait-for <selector>` polls until the
 * real UI is on screen so we never screenshot a blank loading state.
 */

import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../../output.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';
import { detectWorktree } from './worktree-resolve.js';

interface Lane {
  id: string;
  repoPath: string;
  worktreePath: string | null;
  packetId: string | null;
  prNumber?: number | null;
}

interface CaptureArgs {
  packetTarget: string | null;
  url: string | null;
  label: string | null;
  kind: 'screenshot' | 'video';
  phase: 'before' | 'after' | null;
  waitFor: string | null;
  settleMs: number;
  pairId: string | null;
  /** Capture the whole scrollable page, not just the viewport (#1147 D1). */
  fullPage: boolean;
  /** Hover this selector before the shot — surfaces :hover states (#1147 D2). */
  hover: string | null;
  /** Click this selector before the shot — surfaces post-interaction states. */
  click: string | null;
  /** Screenshot ONLY this element's box — frames the actual change so the
   *  preview IS the change, not a full page where it's a thin strip (#1149). */
  clip: string | null;
}

// file:// dropped with the dev-browser retirement (#1648) — the engine's
// capture policy only speaks http(s), loopback or public.
const CAPTURE_URL_PATTERN = /^(https?:\/\/|localhost(?::|\/)|127\.0\.0\.1(?::|\/))/i;

export function parseCaptureArgs(rest: string[]): CaptureArgs {
  const args = parsePacketArguments(rest, {
    command: 'capture',
    valueFlags: ['url', 'label', 'kind', 'wait-for', 'settle', 'pair', 'hover', 'click', 'clip'],
    booleanFlags: ['full-page', 'before', 'after'],
    aliases: { '--fullpage': '--full-page' },
    targetFlags: ['packet', 'lane'],
    positionalValues: [{ name: 'url', matches: (value) => CAPTURE_URL_PATTERN.test(value) }],
  });
  const beforeIndex = rest.lastIndexOf('--before');
  const afterIndex = rest.lastIndexOf('--after');
  const phase = beforeIndex < 0 && afterIndex < 0
    ? null
    : afterIndex > beforeIndex ? 'after' : 'before';

  return {
    packetTarget: args.target,
    url: args.values.url?.trim() || null,
    label: args.values.label?.trim() || null,
    kind: args.values.kind === 'video' ? 'video' : 'screenshot',
    phase,
    waitFor: args.values['wait-for']?.trim() || null,
    settleMs: Math.max(0, Math.min(10_000, Number(args.values.settle) || 0)),
    pairId: args.values.pair?.trim() || null,
    fullPage: args.booleans.has('full-page'),
    hover: args.values.hover?.trim() || null,
    click: args.values.click?.trim() || null,
    clip: args.values.clip?.trim() || null,
  };
}

interface EngineCapture { pngBase64: string; width: number | null; height: number | null }

/** Screenshot via the desktop's in-house headless engine (#1648) — the same
 *  gated API surface every other CLI verb rides, so a fresh machine needs
 *  nothing on PATH. */
async function captureViaEngine(cfg: ReturnType<typeof resolveConfig>, args: CaptureArgs): Promise<EngineCapture> {
  // The taught verb accepts scheme-less loopback forms (`localhost:3000/x`);
  // the engine needs a real URL.
  const url = /^https?:\/\//i.test(args.url ?? '') ? args.url! : `http://${args.url}`;
  const res = await apiFetch<{ ok: boolean; pngBase64?: string; width?: number | null; height?: number | null; error?: string }>(
    cfg,
    '/api/browser/engine/capture',
    {
      method: 'POST',
      body: {
        url,
        waitFor: args.waitFor,
        hover: args.hover,
        click: args.click,
        clip: args.clip,
        settleMs: args.settleMs,
        fullPage: args.fullPage,
      },
    },
  );
  const data = res.data;
  if (!data?.ok || !data.pngBase64) {
    const detail = data?.error ?? 'engine returned no screenshot';
    throw new CliError(
      'capture_failed',
      `Capture failed: ${detail}`,
      EXIT.INVALID_ARGS,
      args.waitFor && /wait/i.test(detail)
        ? `The --wait-for selector "${args.waitFor}" may never have appeared.`
        : detail.includes('playwright-core') || /chrome/i.test(detail)
          ? 'The capture engine needs Google Chrome installed on the o8 machine.'
          : undefined,
    );
  }
  return { pngBase64: data.pngBase64, width: data.width ?? null, height: data.height ?? null };
}

export async function runPacketCapture(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseCaptureArgs(rest);
  if (!args.url) {
    throw new CliError(
      'invalid_args',
      'o8 packet capture requires --url.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet capture --url http://localhost:3000/login --label "login bug" --before --wait-for "[data-testid=login-form]"',
    );
  }

  // Explicit and worker-env targets are fail-closed. Cwd association stays
  // best-effort so a standalone capture can still be stored without a packet.
  const match = detectWorktree(process.cwd());
  const cfg = resolveConfig();
  let lane: Lane | null = null;
  let packetId: string | null = null;
  try {
    const target = await resolvePacketTarget<Lane>(args.packetTarget);
    packetId = target.packetId;
    lane = target.lane;
  } catch (error) {
    if (args.packetTarget || process.env.O8_WORKER_PACKET_ID?.trim()) throw error;
    packetId = match?.packetSlug ?? null;
  }

  const capture = await captureViaEngine(cfg, args);
  const bytesBase64 = capture.pngBase64;

  const res = await apiFetch<{ artifactId: string; url: string; relPath: string }>(cfg, '/api/panel/artifacts', {
    method: 'POST',
    body: {
      bytesBase64,
      mimeType: 'image/png',
      source: 'agent-capture',
      kind: args.kind,
      packetId,
      laneId: lane?.id ?? null,
      repoPath: lane?.repoPath ?? null,
      prNumber: lane?.prNumber ?? null,
      label: args.label,
      phase: args.phase,
      pairId: args.pairId,
      width: capture.width,
      height: capture.height,
    },
  });

  const data = res.data;
  if (!data?.artifactId) {
    throw new CliError('capture_failed', 'Artifact upload returned no id.', EXIT.CONFLICT);
  }

  if (mode.human) {
    printHumanHeading('packet capture');
    printHumanKv([
      ['artifact', data.artifactId],
      ['label', args.label ?? '(none)'],
      ['phase', args.phase ?? '(none)'],
      ['packet', packetId ?? '(unassigned)'],
      ['url', data.url],
    ]);
  } else {
    printJson({
      schema: 'o8/cli/packet.capture/v1',
      artifactId: data.artifactId,
      url: data.url,
      packetId,
      phase: args.phase,
      label: args.label,
    });
  }
  return EXIT.OK;
}
