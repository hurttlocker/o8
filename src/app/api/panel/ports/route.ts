export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

interface PortEntry {
  port: number;
  pid: number;
  process: string;
  cwd: string;
  repo: string | null;
}

interface PortGroup {
  repo: string;
  repoPath: string;
  ports: number[];
}

// Well-known system ports to ignore
const IGNORE_PORTS = new Set([22, 53, 80, 443, 631, 5000, 5353, 7000, 18789]);
const IGNORE_PROCESSES = new Set([
  'rapportd', 'mDNSResponder', 'systemd', 'launchd', 'loginwindow', 'WindowServer',
  'Google Drive', 'CinemaGradeHelper', 'sharingd', 'replicatord', 'identityservicesd',
  'ControlCenter', 'Finder', 'AirPlayXPCHelper', 'WiFiAgent', 'bluetoothd',
]);

export async function GET() {
  try {
    // Get all listening TCP ports
    const raw = execSync(
      'lsof -i -P -n -sTCP:LISTEN -F pcn 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();

    // Parse lsof output (field mode: p=pid, c=command, n=name)
    const entries: PortEntry[] = [];
    let currentPid = 0;
    let currentProcess = '';
    const pidCwdCache = new Map<number, string>();

    for (const line of raw.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = parseInt(line.slice(1), 10);
      } else if (line.startsWith('c')) {
        currentProcess = line.slice(1);
      } else if (line.startsWith('n')) {
        // Parse port from name field like "*:3001" or "127.0.0.1:3001"
        const match = line.match(/:(\d+)$/);
        if (!match) continue;

        const port = parseInt(match[1], 10);
        if (IGNORE_PORTS.has(port)) continue;
        if (IGNORE_PROCESSES.has(currentProcess)) continue;
        if (port < 1024 && currentProcess !== 'node') continue;

        // Resolve CWD for this PID
        let cwd = '';
        if (pidCwdCache.has(currentPid)) {
          cwd = pidCwdCache.get(currentPid)!;
        } else {
          try {
            cwd = execSync(
              `lsof -p ${currentPid} -Fn 2>/dev/null | grep '^n/' | grep 'cwd$' | head -1 | sed 's/^n//'`,
              { encoding: 'utf-8', timeout: 2000 },
            ).trim();
            // Fallback: try /proc on Linux or pwdx
            if (!cwd) {
              cwd = execSync(
                `lsof -p ${currentPid} -a -d cwd -Fn 2>/dev/null | grep '^n' | head -1 | sed 's/^n//'`,
                { encoding: 'utf-8', timeout: 2000 },
              ).trim();
            }
          } catch { /* can't resolve CWD */ }
          pidCwdCache.set(currentPid, cwd);
        }

        // Deduplicate (same port can appear for IPv4 and IPv6)
        if (!entries.some(e => e.port === port)) {
          entries.push({
            port,
            pid: currentPid,
            process: currentProcess,
            cwd,
            repo: null,
          });
        }
      }
    }

    // Match ports to registered repos
    let repos: { name: string; localPath: string }[] = [];
    try {
      const repoData = JSON.parse(
        execSync('cat ~/.cortex-ide/repos.json 2>/dev/null || echo "[]"', { encoding: 'utf-8' }),
      );
      repos = (Array.isArray(repoData) ? repoData : repoData.repos ?? []).map(
        (r: { name?: string; localPath?: string }) => ({
          name: r.name ?? '',
          localPath: r.localPath ?? '',
        }),
      );
    } catch { /* no repo registry */ }

    // Assign repo by CWD matching — longest path wins (most specific)
    const sortedRepos = [...repos].sort((a, b) => b.localPath.length - a.localPath.length);
    for (const entry of entries) {
      if (!entry.cwd) continue;
      for (const repo of sortedRepos) {
        if (entry.cwd.startsWith(repo.localPath)) {
          entry.repo = repo.name;
          break;
        }
      }
    }

    // Filter to only dev-relevant: must be in a registered repo OR be a known dev tool
    const DEV_PROCESSES = new Set(['node', 'next-server', 'tsx', 'bun', 'deno', 'python', 'Python', 'go', 'cargo', 'ruby', 'java', 'uvicorn', 'gunicorn', 'flask']);
    const filtered = entries.filter(e => e.repo !== null || DEV_PROCESSES.has(e.process));

    // Group by repo
    const groups: PortGroup[] = [];
    const repoMap = new Map<string, PortGroup>();

    for (const entry of filtered) {
      const key = entry.repo ?? entry.cwd ?? 'Unknown';
      if (!repoMap.has(key)) {
        const group: PortGroup = {
          repo: entry.repo ?? (entry.cwd ? entry.cwd.split('/').pop() ?? 'Unknown' : 'Unknown'),
          repoPath: entry.cwd,
          ports: [],
        };
        repoMap.set(key, group);
        groups.push(group);
      }
      repoMap.get(key)!.ports.push(entry.port);
    }

    // Sort ports within groups
    for (const g of groups) g.ports.sort((a, b) => a - b);

    return NextResponse.json({
      ports: filtered.sort((a, b) => a.port - b.port),
      groups,
      total: filtered.length,
    });
  } catch (err) {
    return NextResponse.json({
      ports: [],
      groups: [],
      total: 0,
      error: err instanceof Error ? err.message : 'Failed to scan ports',
    });
  }
}
