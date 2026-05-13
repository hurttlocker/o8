/**
 * `o8 doctor` — verify port + token resolution, ping the server, report drift.
 *
 * Drift means the disk port and the actually-reachable port disagree. Useful
 * after a sidecar restart that picked a different port.
 */

import { apiFetch } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

export async function runDoctor(mode: OutputMode): Promise<number> {
  const cfg = resolveConfig();
  const findings: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string }> = [];

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
    process.stdout.write(`\n${payload.ok ? 'OK' : 'FAIL'}\n`);
  } else {
    printJson(payload);
  }

  return payload.ok ? 0 : 1;
}
