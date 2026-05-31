export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { listManagedRuns, listRunningRuns } from '@/lib/runtimes/managed-runs/registry';

/** agent = o8-owned run (→ live terminal) · browser = dev server (→ preview) · noise = db/infra (collapsed) */
type PortCategory = 'agent' | 'browser' | 'noise';

interface PortEntry {
  port: number;
  pid: number;
  process: string;
  cwd: string;
  repo: string | null;
  category: PortCategory;
  agentSession: string | null;
}

// ── Response cache (ports don't change fast enough to scan every request) ──
let portsCache: { data: unknown; ts: number } | null = null;
const PORTS_CACHE_TTL_MS = 10_000; // 10s cache — ports don't change every second

interface PortGroup {
  repo: string;
  repoPath: string;
  ports: number[];
}

// Well-known system ports to ignore
const IGNORE_PORTS = new Set([22, 53, 80, 443, 631, 5000, 5353, 7000]);
const IGNORE_PROCESSES = new Set([
  'rapportd', 'mDNSResponder', 'systemd', 'launchd', 'loginwindow', 'WindowServer',
  'Google Drive', 'CinemaGradeHelper', 'sharingd', 'replicatord', 'identityservicesd',
  'ControlCenter', 'Finder', 'AirPlayXPCHelper', 'WiFiAgent', 'bluetoothd',
]);

export async function GET() {
  // Return cached response if fresh
  if (portsCache && (Date.now() - portsCache.ts) < PORTS_CACHE_TTL_MS) {
    return NextResponse.json(portsCache.data);
  }

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

        // CWD resolution deferred to batch below
        const cwd = '';

        // Deduplicate the SAME process double-binding (IPv4 + IPv6) by (pid,port);
        // two DIFFERENT processes on one port number are both kept so the
        // agent-owned one can still be attributed (collapsed for render later).
        if (!entries.some(e => e.pid === currentPid && e.port === port)) {
          entries.push({
            port,
            pid: currentPid,
            process: currentProcess,
            cwd,
            repo: null,
            category: 'browser',
            agentSession: null,
          });
        }
      }
    }

    // Batch-resolve CWDs for all unique PIDs in one lsof call
    const uniquePids = [...new Set(entries.map(e => e.pid))];
    if (uniquePids.length > 0) {
      try {
        const pidList = uniquePids.join(',');
        const cwdRaw = execSync(
          `lsof -p ${pidList} -a -d cwd -Fn 2>/dev/null`,
          { encoding: 'utf-8', timeout: 3000 },
        ).trim();
        let pid = 0;
        for (const line of cwdRaw.split('\n')) {
          if (line.startsWith('p')) pid = parseInt(line.slice(1), 10);
          else if (line.startsWith('n') && pid) pidCwdCache.set(pid, line.slice(1));
        }
      } catch { /* batch CWD resolution failed — entries keep empty cwd */ }

      for (const entry of entries) {
        entry.cwd = pidCwdCache.get(entry.pid) ?? '';
      }
    }

    // Match ports to registered repos
    let repos: { name: string; localPath: string }[] = [];
    try {
      const repoData = JSON.parse(
        execSync('cat ~/.o8/repos.json 2>/dev/null || echo "[]"', { encoding: 'utf-8' }),
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

    // Tag EVERY listening port BEFORE the dev-relevance filter — agent ownership
    // is the strongest signal and must not be gated behind the weakest heuristic
    // (an o8-owned port of an arbitrary binary outside a registered repo would
    // otherwise be dropped before it could be tagged 'agent'):
    //  - agent: the process descends from a live `o8 run` tmux pane (pane-pid
    //    ancestry — o8 owns the session, so the port's process is in its tree).
    //  - noise: db/cache/infra → collapsed.  - browser: dev server → preview.
    const NOISE_PROCESSES = ['postgres', 'postmaster', 'redis', 'mysqld', 'mariadbd', 'mongod', 'memcached', 'elasticsearch', 'rabbitmq', 'etcd', 'clickhouse'];
    const classifyNonAgent = (entry: PortEntry) => {
      entry.category = NOISE_PROCESSES.some(p => entry.process.toLowerCase().includes(p)) ? 'noise' : 'browser';
    };
    try {
      await listManagedRuns(); // reconcile against live tmux (flips dead runs away)
      const panePidToRun = new Map<number, string>();
      for (const run of listRunningRuns()) {
        if (typeof run.panePid === 'number') panePidToRun.set(run.panePid, run.session);
      }
      let ownerSession: (pid: number) => string | null = () => null;
      if (panePidToRun.size > 0) {
        // One ps snapshot → pid→ppid map; walk each port's process up to a run pane.
        const ppidByPid = new Map<number, number>();
        try {
          const psRaw = execSync('ps -axo pid=,ppid= 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
          for (const line of psRaw.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)$/);
            if (m) ppidByPid.set(parseInt(m[1], 10), parseInt(m[2], 10));
          }
        } catch { /* ps failed — no agent tags this pass */ }
        ownerSession = (pid: number): string | null => {
          let cur = pid;
          for (let hops = 0; cur > 1 && hops < 32; hops += 1) {
            const session = panePidToRun.get(cur);
            if (session) return session;
            const parent = ppidByPid.get(cur);
            if (parent === undefined || parent === cur) break;
            cur = parent;
          }
          return null;
        };
      }
      for (const entry of entries) {
        const session = ownerSession(entry.pid);
        if (session) { entry.category = 'agent'; entry.agentSession = session; }
        else classifyNonAgent(entry);
      }
    } catch { /* registry/tmux unavailable — entries keep default 'browser' */ }

    // Keep agent-owned ports regardless of repo/process; otherwise require a
    // registered repo or a known dev tool.
    const DEV_PROCESSES = new Set(['node', 'next-server', 'tsx', 'bun', 'deno', 'python', 'Python', 'go', 'cargo', 'ruby', 'java', 'uvicorn', 'gunicorn', 'flask']);
    const relevant = entries.filter(e => e.category === 'agent' || e.repo !== null || DEV_PROCESSES.has(e.process));

    // One row per port number for the UI — prefer the agent-owned entry when two
    // distinct processes hold the same port.
    const byPort = new Map<number, PortEntry>();
    for (const entry of relevant) {
      const existing = byPort.get(entry.port);
      if (!existing || (entry.category === 'agent' && existing.category !== 'agent')) byPort.set(entry.port, entry);
    }
    const filtered = [...byPort.values()];

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

    const result = {
      ports: filtered.sort((a, b) => a.port - b.port),
      groups,
      total: filtered.length,
    };
    portsCache = { data: result, ts: Date.now() };
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({
      ports: [],
      groups: [],
      total: 0,
      error: err instanceof Error ? err.message : 'Failed to scan ports',
    });
  }
}
