// Owned-process cleanup for the interaction harness. Ownership is established
// by explicit roots plus a run-unique tag. The inventory retains descendants
// after their PPID changes, so a launcher exiting cannot hide a reparented
// next-server, websocket helper, fixture server, or browser helper.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseProcessInventory(output) {
  const processes = new Map();
  for (const line of String(output).split('\n')) {
    const match = line.match(PROCESS_LINE);
    if (!match) continue;
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4].trim(),
    });
  }
  return processes;
}

export function snapshotProcessInventory(run = execFileSync) {
  return parseProcessInventory(run('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }));
}

function sameProcess(identity, process) {
  return identity?.pid === process?.pid && identity?.command === process?.command;
}

function processLabel(command, fallback = 'descendant') {
  if (command.includes('--type=renderer')) return 'browser-renderer';
  if (command.includes('--type=')) return 'browser-helper';
  if (command.includes('--serve-interaction-fixture')) return 'fixture-server';
  if (command.includes('next-server')) return 'next-server';
  if (command.includes('scripts/start.mjs')) return 'application-launcher';
  if (command.includes('ws-server')) return 'websocket-server';
  if (command.includes('/server.js')) return 'packaged-server';
  return fallback;
}

export function createOwnedProcessInventory(runTag, { harnessPid = process.pid } = {}) {
  if (!runTag || !/^[a-zA-Z0-9._-]+$/.test(runTag)) {
    throw new Error('interaction run tag must contain only letters, numbers, dot, underscore, and hyphen');
  }
  return {
    runTag,
    harnessPid,
    roots: new Map(),
    processes: new Map(),
    safeProcessGroups: new Set(),
    captures: 0,
    snapshotErrors: [],
  };
}

export function addOwnedProcessRoot(inventory, pid, label, processes = snapshotProcessInventory()) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  inventory.roots.set(pid, label);
  const root = processes.get(pid);
  const harnessGroup = processes.get(inventory.harnessPid)?.pgid ?? null;
  if (root && root.pgid > 0 && root.pgid === root.pid && root.pgid !== harnessGroup) {
    inventory.safeProcessGroups.add(root.pgid);
  }
  captureOwnedProcessTree(inventory, processes);
}

// Captures descendants by ancestry and by process group. Process-group capture
// is what finds a child after its launcher exits and launchd becomes its PPID.
// Once captured, PID + command identity remains owned for the rest of the run.
export function captureOwnedProcessTree(inventory, processes = snapshotProcessInventory()) {
  inventory.captures += 1;
  const ownedNow = new Set();
  const tagged = [...processes.values()].filter((entry) => entry.command.includes(inventory.runTag));
  for (const entry of tagged) ownedNow.add(entry.pid);
  for (const [pid, identity] of inventory.processes) {
    if (sameProcess(identity, processes.get(pid))) ownedNow.add(pid);
  }
  for (const pid of inventory.roots.keys()) {
    if (processes.has(pid)) ownedNow.add(pid);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes.values()) {
      const groupOwned = inventory.safeProcessGroups.has(entry.pgid);
      if (!ownedNow.has(entry.pid) && (ownedNow.has(entry.ppid) || groupOwned)) {
        ownedNow.add(entry.pid);
        changed = true;
      }
    }
  }

  for (const pid of ownedNow) {
    const entry = processes.get(pid);
    if (!entry) continue;
    const rootLabel = inventory.roots.get(pid);
    const previousLabel = inventory.processes.get(pid)?.label;
    inventory.processes.set(pid, {
      ...entry,
      label: processLabel(entry.command, rootLabel ?? previousLabel ?? 'descendant'),
    });
  }
  return inventory;
}

export function captureOwnedProcessTreeSafe(inventory, processes) {
  try {
    captureOwnedProcessTree(inventory, processes ?? snapshotProcessInventory());
    return true;
  } catch (error) {
    inventory.snapshotErrors.push(error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function survivingOwnedProcesses(inventory, processes = snapshotProcessInventory()) {
  captureOwnedProcessTree(inventory, processes);
  return [...inventory.processes.values()]
    .filter((identity) => sameProcess(identity, processes.get(identity.pid)))
    .map(({ pid, ppid, pgid, label }) => ({ pid, ppid: processes.get(pid)?.ppid ?? ppid, pgid, label }))
    .sort((left, right) => left.pid - right.pid);
}

function signalProcesses(processes, signal, kill = process.kill) {
  for (const entry of [...processes].sort((left, right) => right.pid - left.pid)) {
    try { kill(entry.pid, signal); } catch { /* already exited */ }
  }
}

async function waitUntilGone(inventory, timeoutMs, snapshot, sleep) {
  const deadline = Date.now() + timeoutMs;
  let survivors = survivingOwnedProcesses(inventory, snapshot());
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(50);
    survivors = survivingOwnedProcesses(inventory, snapshot());
  }
  return survivors;
}

export async function terminateAndWaitOwnedProcesses(inventory, {
  graceMs = 1_000,
  termMs = 2_500,
  killMs = 2_500,
  snapshot = snapshotProcessInventory,
  sleep = wait,
  kill = process.kill,
} = {}) {
  const safeSnapshot = () => {
    try { return snapshot(); } catch (error) {
      inventory.snapshotErrors.push(error instanceof Error ? error.message : String(error));
      return new Map();
    }
  };
  const initial = survivingOwnedProcesses(inventory, safeSnapshot());
  let survivors = await waitUntilGone(inventory, graceMs, safeSnapshot, sleep);
  const signaledTerm = survivors.map((entry) => entry.pid);
  signalProcesses(survivors, 'SIGTERM', kill);
  survivors = await waitUntilGone(inventory, termMs, safeSnapshot, sleep);
  const signaledKill = survivors.map((entry) => entry.pid);
  signalProcesses(survivors, 'SIGKILL', kill);
  survivors = await waitUntilGone(inventory, killMs, safeSnapshot, sleep);
  const inventoriedByLabel = {};
  for (const process of inventory.processes.values()) {
    inventoriedByLabel[process.label] = (inventoriedByLabel[process.label] ?? 0) + 1;
  }
  return {
    runTag: inventory.runTag,
    captures: inventory.captures,
    roots: [...inventory.roots].map(([pid, label]) => ({ pid, label })),
    inventoriedCount: inventory.processes.size,
    inventoriedByLabel,
    initial,
    signaledTerm,
    signaledKill,
    survivors,
    snapshotErrors: [...new Set(inventory.snapshotErrors)],
  };
}

export async function portFree(port) {
  if (!Number.isInteger(port) || port <= 0) return true;
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const settle = (free) => { socket.destroy(); resolve(free); };
    socket.setTimeout(750);
    socket.once('connect', () => settle(false));
    socket.once('timeout', () => settle(true));
    socket.once('error', () => settle(true));
  });
}

export function listTmuxSessions() {
  try {
    return execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function ownedTmuxSessions(dataDir) {
  if (!dataDir) return [];
  try {
    const output = execFileSync('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const owned = new Set();
    for (const line of output.split('\n')) {
      const [sessionName, panePath] = line.split('\t');
      if (sessionName && panePath && panePath.startsWith(dataDir)) owned.add(sessionName);
    }
    return [...owned];
  } catch {
    return [];
  }
}

export function killTmuxSessions(sessionNames) {
  const killed = [];
  for (const sessionName of new Set(sessionNames)) {
    try {
      execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
      killed.push(sessionName);
    } catch { /* already gone */ }
  }
  return killed;
}

export function listWorktrees(repoDir) {
  if (!repoDir || !fs.existsSync(repoDir)) return [];
  try {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  } catch {
    return [];
  }
}

export async function verifyCleanup({
  processTermination = null,
  ownedInventory = null,
  ports = [],
  dataDir = null,
  repoDir = null,
  tmuxSessionsBefore = [],
  worktreesBefore = [],
  worktreesAfter = null,
}) {
  const residue = {};
  const processSurvivors = processTermination?.survivors
    ?? (ownedInventory ? survivingOwnedProcesses(ownedInventory) : []);
  if (processSurvivors.length > 0) residue.processes = processSurvivors;
  if ((processTermination?.snapshotErrors?.length ?? 0) > 0) {
    residue.processInventoryErrors = processTermination.snapshotErrors;
  }

  const busyPorts = [];
  for (const port of ports) {
    if (!(await portFree(port))) busyPorts.push(port);
  }
  if (busyPorts.length > 0) residue.ports = busyPorts;
  if (dataDir && fs.existsSync(dataDir)) residue.dataDir = dataDir;

  const ownedAfter = ownedTmuxSessions(dataDir);
  if (ownedAfter.length > 0) residue.tmuxSessions = ownedAfter;
  const foreignTmux = listTmuxSessions().filter((name) => (
    !tmuxSessionsBefore.includes(name) && !ownedAfter.includes(name)
  ));
  const newWorktrees = (worktreesAfter ?? listWorktrees(repoDir)).filter((worktree) => !worktreesBefore.includes(worktree));
  if (newWorktrees.length > 0) residue.worktrees = newWorktrees;

  return {
    status: Object.keys(residue).length === 0 ? 'clean' : 'residue',
    checked: {
      processTermination,
      ports,
      dataDir,
      repoDir,
      tmuxSessionsBefore: tmuxSessionsBefore.length,
      worktreesBefore: worktreesBefore.length,
      foreignTmuxSessionsObserved: foreignTmux,
    },
    residue: Object.keys(residue).length === 0 ? null : residue,
  };
}
