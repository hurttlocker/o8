/**
 * `o8 packet capture` — agent-facing visual proof capture (#1147 phase 1).
 *
 * Drives the on-PATH dev-browser managed Chromium to screenshot the agent's
 * own running app (the localhost server it started via `o8 run`), then uploads
 * the bytes to /api/panel/artifacts so the proof rides back to the orchestrator
 * in the packet status payload and surfaces as a before/after strip in o8.
 *
 *   o8 packet capture --url http://localhost:3000/login --label "login bug" --before
 *   o8 packet capture --url http://localhost:3000/login --label "fixed" --after \
 *       --wait-for "[data-testid=dashboard]" --settle 400
 *
 * Capture timing is the whole ballgame — `--wait-for <selector>` polls until the
 * real UI is on screen so we never screenshot a blank loading state.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

const CAPTURE_URL_PATTERN = /^(https?:\/\/|file:\/\/|localhost(?::|\/)|127\.0\.0\.1(?::|\/))/i;

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

interface DevBrowserCapture { path: string; width: number | null; height: number | null }

/** Drive dev-browser to navigate + (optionally) wait for a selector + screenshot. */
async function captureViaDevBrowser(args: CaptureArgs): Promise<DevBrowserCapture> {
  const waitMs = 10_000;
  const name = `o8cap-${Date.now()}`;
  // Inject values via JSON.stringify so URLs/selectors with quotes survive.
  const script = `
    const page = await browser.getPage("o8-capture");
    await page.goto(${JSON.stringify(args.url)}, { waitUntil: "domcontentloaded", timeout: 30000 });
    ${args.waitFor ? `await page.waitForSelector(${JSON.stringify(args.waitFor)}, { state: "visible", timeout: ${waitMs} });
    try { await page.locator(${JSON.stringify(args.waitFor)}).first().scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}` : ''}
    ${args.hover ? `try { await page.hover(${JSON.stringify(args.hover)}, { timeout: ${waitMs} }); } catch {}` : ''}
    ${args.click ? `try { await page.click(${JSON.stringify(args.click)}, { timeout: ${waitMs} }); } catch {}` : ''}
    ${args.settleMs > 0 ? `await page.waitForTimeout(${args.settleMs});` : ''}
    ${args.clip
      ? `const __clip = page.locator(${JSON.stringify(args.clip)}).first();
    try { await __clip.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
    const buf = await __clip.screenshot();`
      : `const buf = await page.screenshot({ fullPage: ${args.fullPage ? 'true' : 'false'} });`}
    const p = await saveScreenshot(buf, ${JSON.stringify(name + '.png')});
    let vp = null; try { vp = page.viewportSize(); } catch {}
    console.log("O8CAP:" + JSON.stringify({ path: p, width: vp && vp.width, height: vp && vp.height }));
  `;

  return new Promise<DevBrowserCapture>((resolve, reject) => {
    let proc;
    try {
      // Headless, and on an ISOLATED daemon instance: --headless relaunches the
      // daemon-managed browser when the existing one is headed, so without the
      // dedicated --browser name a packet capture would tear down the
      // operator's own visible dev-browser session (report J4FHM2 — workers
      // popping a headed browser outside the o8 app).
      proc = spawn('dev-browser', ['--headless', '--browser', 'o8-capture'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      reject(new CliError('dev_browser_missing', 'dev-browser not found on PATH.', EXIT.NOT_FOUND, 'Visual capture needs the dev-browser CLI. Install it or run capture on a machine where it is available.'));
      return;
    }
    let stdout = '';
    let stderr = '';
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } }, 60_000);

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(killTimer);
      if (err.code === 'ENOENT') {
        reject(new CliError('dev_browser_missing', 'dev-browser not found on PATH.', EXIT.NOT_FOUND, 'Visual capture needs the dev-browser CLI on PATH.'));
      } else {
        reject(new CliError('capture_failed', `dev-browser failed: ${err.message}`, EXIT.INVALID_ARGS));
      }
    });
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    proc.on('close', (code: number | null) => {
      clearTimeout(killTimer);
      const line = stdout.split('\n').find((l) => l.startsWith('O8CAP:'));
      if (!line) {
        reject(new CliError('capture_failed', `Capture produced no screenshot (exit ${code}). ${stderr.slice(0, 300)}`.trim(), EXIT.INVALID_ARGS, args.waitFor ? `The --wait-for selector "${args.waitFor}" may never have appeared.` : undefined));
        return;
      }
      try {
        const parsed = JSON.parse(line.slice('O8CAP:'.length)) as DevBrowserCapture;
        if (!parsed.path) throw new Error('no path');
        resolve({ path: parsed.path, width: parsed.width ?? null, height: parsed.height ?? null });
      } catch {
        reject(new CliError('capture_failed', 'Could not parse capture output.', EXIT.INVALID_ARGS));
      }
    });

    try {
      proc.stdin?.write(script, 'utf8');
      proc.stdin?.end();
    } catch {
      // surfaced via 'error'/'close'
    }
  });
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

  const capture = await captureViaDevBrowser(args);
  const bytesBase64 = (await readFile(capture.path)).toString('base64');

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
