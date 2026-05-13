/**
 * `o8 doctor` — verify port + token resolution, ping the server, report drift.
 *
 * Drift means the disk port and the actually-reachable port disagree. Useful
 * after a sidecar restart that picked a different port.
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

interface ReapCandidate {
  lane: {
    id: string;
    label: string;
    packetId: string | null;
    status: string;
    repoPath: string;
    branch: string;
    sessionKey: string | null;
  };
  staleMs: number;
  lastHeartbeatAt: number | null;
  probe: {
    source: string;
    pid?: number;
    sessionName?: string;
    note?: string;
  };
  reason: string;
}

interface ReapResponse {
  ok: boolean;
  candidates: ReapCandidate[];
  reaped?: Array<{ candidate: ReapCandidate }>;
}

function parseDoctorArgs(rest: string[]) {
  let reap = false;
  let force = false;
  for (const tok of rest) {
    if (tok === '--reap') reap = true;
    else if (tok === '--force') force = true;
    else {
      throw new CliError('invalid_args', `Unknown doctor flag: ${tok}`, EXIT.INVALID_ARGS);
    }
  }
  if (force && !reap) {
    throw new CliError('invalid_args', '`o8 doctor --force` requires --reap.', EXIT.INVALID_ARGS);
  }
  return { reap, force };
}

export async function runDoctor(mode: OutputMode, rest: string[] = []): Promise<number> {
  const args = parseDoctorArgs(rest);
  const cfg = resolveConfig();
  const findings: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string }> = [];
  let reapPayload: ReapResponse | null = null;

  let serverReachable = false;
  let serverPayload: Record<string, unknown> | null = null;
  try {
    const res = await apiFetch<Record<string, unknown>>(cfg, '/api/panel/status');
    serverReachable = res.status === 200;
    serverPayload = res.data ?? null;
  } catch (err) {
    serverReachable = false;
    findings.push({
      level: 'error',
      code: (err as { code?: string }).code ?? 'unreachable',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (serverReachable && !cfg.token && cfg.source.port !== 'env') {
    findings.push({
      level: 'info',
      code: 'no_token',
      message: 'No bearer token found. Loopback fetches still work; cross-origin will 401.',
    });
  }
  if (cfg.source.port === 'default') {
    findings.push({
      level: 'warn',
      code: 'default_port',
      message: 'No api-port file on disk; using fallback 3001. Sidecar may not have started.',
    });
  }
  if (cfg.source.port === 'cortex-ide-dir' || cfg.source.token === 'cortex-ide-dir') {
    findings.push({
      level: 'info',
      code: 'legacy_data_dir',
      message: 'Reading config from ~/.cortex-ide/ (legacy). New installs use ~/.o8/.',
    });
  }

  if (args.reap && serverReachable) {
    const res = await apiFetch<ReapResponse>(cfg, '/api/lanes/reap', {
      method: 'POST',
      body: { force: args.force },
    });
    reapPayload = res.data;
  }

  const payload = {
    schema: 'o8/cli/doctor/v1',
    ok: serverReachable && !findings.some((f) => f.level === 'error'),
    config: {
      apiPort: cfg.apiPort,
      apiBase: cfg.apiBase,
      portSource: cfg.source.port,
      tokenPresent: cfg.token != null,
      tokenSource: cfg.source.token,
      dataDir: cfg.dataDir,
    },
    server: {
      reachable: serverReachable,
      response: serverPayload,
    },
    reap: reapPayload ? {
      force: args.force,
      candidates: reapPayload.candidates,
      reaped: reapPayload.reaped ?? [],
    } : null,
    findings,
  };

  if (mode.human) {
    printHumanHeading('o8 doctor');
    printHumanKv([
      ['api port', String(cfg.apiPort)],
      ['port source', cfg.source.port],
      ['token', cfg.token ? `present (${cfg.source.token})` : 'none'],
      ['data dir', cfg.dataDir ?? '(none)'],
      ['reachable', serverReachable ? 'yes' : 'no'],
    ]);
    if (findings.length > 0) {
      printHumanHeading('findings');
      for (const f of findings) {
        process.stdout.write(`  [${f.level}] ${f.code} — ${f.message}\n`);
      }
    }
    if (reapPayload) {
      printHumanHeading(args.force ? 'reaped zombie lanes' : 'zombie lane candidates');
      if (reapPayload.candidates.length === 0) {
        process.stdout.write('  none\n');
      } else {
        for (const candidate of reapPayload.candidates) {
          const age = Math.round(candidate.staleMs / 1000);
          const owner = candidate.probe.pid
            ? `pid ${candidate.probe.pid}`
            : candidate.probe.sessionName
              ? `session ${candidate.probe.sessionName}`
              : candidate.probe.source;
          process.stdout.write(
            `  ${candidate.lane.id} ${candidate.lane.packetId ?? '(no packet)'} ${candidate.lane.branch} — stale ${age}s, owner ${owner}\n`,
          );
        }
      }
    }
    process.stdout.write(`\n${payload.ok ? 'OK' : 'FAIL'}\n`);
  } else {
    printJson(payload);
  }

  return payload.ok ? 0 : 1;
}
