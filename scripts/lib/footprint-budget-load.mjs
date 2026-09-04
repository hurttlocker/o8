import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  descendantPids,
  redactedDigest,
  snapshotProcesses,
  summarizeFootprintSamples,
} from './footprint-budget.mjs';

export const LOAD_SCENARIO_LIMITS = Object.freeze({
  maxLaneCount: 4,
  activationTimeoutMs: 300_000,
  drainTimeoutMs: 120_000,
  pollMs: 2_000,
});

// An unavailable load scenario is RECORDED, never approximated. Every reason
// here means "the loaded number was not measured", so no consumer can mistake
// a skipped run for a proven one.
export const LOAD_UNAVAILABLE_REASONS = Object.freeze({
  notRequested: 'not-requested',
  loadRepoNotConfigured: 'load-repo-not-configured',
  loadRepoMissing: 'load-repo-missing',
  loadRepoNotIsolated: 'load-repo-not-isolated',
  loadRepoIsReleaseCheckout: 'load-repo-is-release-checkout',
  loadRepoRegistered: 'load-repo-is-registered-operator-repo',
  registeredReposUnreadable: 'registered-operator-repos-unreadable',
  runtimeNotSupported: 'runtime-not-supported-by-load-scenario',
  workerRuntimeUnavailable: 'worker-runtime-unavailable',
  apiTokenUnavailable: 'api-token-unavailable',
  preExistingLanes: 'pre-existing-lanes',
  lanesDidNotReachActive: 'lanes-did-not-reach-active',
  residualStatePreserved: 'residual-state-preserved',
});

// Runtime ids are NOT executable names (`claude-code` runs `claude`, `cursor`
// runs `cursor-agent`). The load scenario supports this explicit subset, and
// tests/footprint-load-route-path.test.ts binds every row to the product's own
// ORCHESTRATOR_RUNTIMES capability table so the mapping cannot drift.
export const LOAD_RUNTIME_BINARIES = Object.freeze({
  codex: 'codex',
  'claude-code': 'claude',
  gemini: 'gemini',
  cursor: 'cursor-agent',
  grok: 'grok',
});

// A lane is finished only in the product's own lane-terminal set; anything else
// still counts as load. Bound to LANE_TERMINAL_STATUSES by the route-path test.
export const LOAD_TERMINAL_LANE_STATUSES = Object.freeze(['failed', 'completed', 'archived']);

// close-unmerged accepts exactly adopted_elsewhere | superseded | spec_changed |
// wontfix (src/lib/orchestrator/close-unmerged-shared.ts). Anything else is a
// 400 invalid_disposition, which would leave every measurement packet open.
// `wontfix` is the neutral truth for a disposable measurement lane: its work was
// never meant to land. Bound to the product guard by the route-path test.
const LOAD_TASK_BODY = [
  'Footprint load measurement lane.',
  'Do not modify, create, or delete any file. Do not run git write commands.',
  'Read the repository README and report a one-line summary, then stop.',
].join('\n');

export function resolveLoadScenarioRequest(env = process.env, limits = LOAD_SCENARIO_LIMITS) {
  const raw = (env.O8_FOOTPRINT_LOAD_LANES ?? '').trim();
  if (!raw || raw === '0') return { laneCount: 0 };
  const laneCount = Number(raw);
  if (!Number.isInteger(laneCount) || laneCount < 0) {
    throw new Error(`O8_FOOTPRINT_LOAD_LANES must be a non-negative integer: ${raw}`);
  }
  if (laneCount > limits.maxLaneCount) {
    throw new Error(`O8_FOOTPRINT_LOAD_LANES ${laneCount} exceeds the bound of ${limits.maxLaneCount}`);
  }
  const runtime = (env.O8_FOOTPRINT_LOAD_RUNTIME ?? 'codex').trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(runtime)) {
    throw new Error(`O8_FOOTPRINT_LOAD_RUNTIME must be a plain runtime id: ${runtime}`);
  }
  return {
    laneCount,
    repoPath: (env.O8_FOOTPRINT_LOAD_REPO ?? '').trim() || null,
    runtime,
  };
}

function unavailable(reason, detail) {
  return detail === undefined
    ? { available: false, reason }
    : { available: false, reason, detail };
}

export function planLoadScenario({ request, probes }) {
  if (!request.laneCount) return unavailable(LOAD_UNAVAILABLE_REASONS.notRequested);
  if (!request.repoPath) return unavailable(LOAD_UNAVAILABLE_REASONS.loadRepoNotConfigured);
  if (!probes.pathExists(request.repoPath)) return unavailable(LOAD_UNAVAILABLE_REASONS.loadRepoMissing);
  // A load run dispatches real workers against this repo. It may only ever
  // point at a disposable repo: never the operator's live profile, never the
  // checkout this release is built from, and never a repository the operator
  // has connected. An explicit temp clone clears all three.
  if (probes.isLiveOperatorPath(request.repoPath)) return unavailable(LOAD_UNAVAILABLE_REASONS.loadRepoNotIsolated);
  if (probes.isReleaseCheckoutPath(request.repoPath)) {
    return unavailable(LOAD_UNAVAILABLE_REASONS.loadRepoIsReleaseCheckout);
  }
  const registered = probes.registeredOperatorRepos();
  // Not knowing which repos are the operator's is not permission to dispatch.
  if (!registered.readable) {
    return unavailable(LOAD_UNAVAILABLE_REASONS.registeredReposUnreadable, registered.detail);
  }
  const registeredMatch = findRegisteredOperatorRepo(request.repoPath, registered.paths);
  if (registeredMatch) {
    // The identity is digested: a release receipt names WHICH repo matched
    // without publishing an operator path.
    return unavailable(LOAD_UNAVAILABLE_REASONS.loadRepoRegistered, {
      registeredRepoDigest: redactedDigest(registeredMatch),
    });
  }
  const binaryName = LOAD_RUNTIME_BINARIES[request.runtime];
  if (!binaryName) {
    return unavailable(LOAD_UNAVAILABLE_REASONS.runtimeNotSupported, { supported: Object.keys(LOAD_RUNTIME_BINARIES) });
  }
  if (!probes.binaryAvailable(binaryName)) {
    return unavailable(LOAD_UNAVAILABLE_REASONS.workerRuntimeUnavailable, { binaryName });
  }
  if (!probes.apiTokenAvailable()) return unavailable(LOAD_UNAVAILABLE_REASONS.apiTokenUnavailable);
  return {
    available: true,
    laneCount: request.laneCount,
    runtime: request.runtime,
    binaryName,
    repoPath: request.repoPath,
  };
}

export function isLiveOperatorPath(target, homeDir) {
  const resolved = canonicalPath(target);
  const liveDataDir = canonicalPath(path.join(homeDir, '.o8'));
  return resolved === liveDataDir || resolved.startsWith(`${liveDataDir}${path.sep}`);
}

function pathContains(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function canonicalPath(target) {
  try {
    return realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Overlap in EITHER direction is disqualifying. A load repo nested inside a
 * protected tree obviously is that tree's working copy, and a load repo that
 * CONTAINS one puts the protected checkout inside the directory real workers
 * are pointed at.
 */
export function pathsOverlap(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return pathContains(a, b) || pathContains(b, a);
}

/**
 * The checkout this release is being built from. Dispatching real workers into
 * it would create branches and worktrees in the very tree that is about to be
 * packaged, so the gate refuses rather than measuring against it.
 */
export function isReleaseCheckoutPath(target, checkoutRoot) {
  return pathsOverlap(target, checkoutRoot);
}

/**
 * Any repository the operator has connected. These hold real work; a load run
 * is disposable by definition, so the two sets must never intersect.
 */
export function findRegisteredOperatorRepo(target, registeredPaths) {
  return registeredPaths.find((registered) => pathsOverlap(target, registered)) ?? null;
}

/**
 * Registered repository paths from the operator's LIVE profile. An absent
 * registry is a real "nothing is registered"; an unparsable or unexpectedly
 * shaped one is an UNKNOWN answer, and an unknown answer cannot clear a repo
 * for real worker dispatch — the caller refuses instead of guessing.
 */
export function readRegisteredOperatorRepoPaths(dataDir, io = { readFileSync }) {
  const registryPath = path.join(dataDir, 'repos.json');
  let raw;
  try {
    raw = io.readFileSync(registryPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { readable: true, paths: [] };
    return { readable: false, detail: { registry: 'unreadable' } };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { readable: false, detail: { registry: 'unparsable' } };
  }
  const repos = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.repos)
      ? parsed.repos
      : null;
  if (!repos) {
    return { readable: false, detail: { registry: 'unexpected-shape' } };
  }
  const paths = [];
  for (const repo of repos) {
    const rawPath = typeof repo?.localPath === 'string'
      ? repo.localPath
      : typeof repo?.path === 'string'
        ? repo.path
        : '';
    const localPath = rawPath.trim();
    // A row that names no directory cannot BE the load repo, so skipping it
    // never widens what this probe clears.
    if (localPath) paths.push(path.resolve(localPath));
  }
  return { readable: true, paths };
}

/**
 * The probe set the gate runs with, assembled here so the wiring itself is
 * testable rather than living inline in the gate script.
 */
export function createLoadScenarioProbes({
  checkoutRoot,
  operatorDataDir,
  homeDir,
  binaryAvailable,
  apiTokenAvailable,
  pathExists = (target) => existsSync(target),
  readRegistered = readRegisteredOperatorRepoPaths,
}) {
  return {
    pathExists,
    isLiveOperatorPath: (target) => isLiveOperatorPath(target, homeDir),
    isReleaseCheckoutPath: (target) => isReleaseCheckoutPath(target, checkoutRoot),
    registeredOperatorRepos: () => readRegistered(operatorDataDir),
    binaryAvailable,
    apiTokenAvailable,
  };
}

/** The exact load-planning entry point used by the pre-ship gate. */
export function planGateLoadScenario({
  env,
  checkoutRoot,
  operatorDataDir,
  homeDir,
  binaryAvailable,
  apiTokenAvailable,
  pathExists,
  readRegistered,
}) {
  const request = resolveLoadScenarioRequest(env);
  return {
    request,
    plan: planLoadScenario({
      request,
      probes: createLoadScenarioProbes({
        checkoutRoot,
        operatorDataDir,
        homeDir,
        binaryAvailable,
        apiTokenAvailable,
        ...(pathExists ? { pathExists } : {}),
        ...(readRegistered ? { readRegistered } : {}),
      }),
    }),
  };
}

export function parseWorktreePaths(output) {
  return String(output)
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

export function parseListeningPorts(output) {
  const ports = new Set();
  for (const match of String(output).matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
    ports.add(Number(match[1]));
  }
  return ports;
}

export function listeningPortsForPids(pids, run = execFileSync) {
  if (pids.size === 0) return new Set();
  try {
    const output = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', [...pids].join(',')], { encoding: 'utf8' });
    return parseListeningPorts(output);
  } catch {
    // The probe exits non-zero when nothing matches; that is an empty result.
    return new Set();
  }
}

// Every operator route answers `{ ok, result }` (see src/app/api/orchestrator/_utils.ts).
// Reading a bare top-level field would silently see `undefined` forever.
export function unwrapOperatorResult(payload, route) {
  if (!payload || payload.ok !== true) {
    throw new Error(`${route} failed: ${payload?.error?.code ?? 'unknown_error'}`);
  }
  return payload.result;
}

export function isActiveLaneStatus(status) {
  return Boolean(status) && !LOAD_TERMINAL_LANE_STATUSES.includes(String(status));
}

export function createHttpLoadDriver({
  apiBase,
  token,
  repoPath,
  runtime,
  rootPid,
  fetchImpl = fetch,
  run = execFileSync,
  snapshot = snapshotProcesses,
  limits = LOAD_SCENARIO_LIMITS,
  now = () => Date.now(),
}) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function post(route, body) {
    const response = await fetchImpl(`${apiBase}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return unwrapOperatorResult(await response.json(), route);
  }

  async function scopedAgents(packetIds) {
    const response = await fetchImpl(`${apiBase}/api/orchestrator/status`, { headers });
    // No mission exists yet: the real route answers 404 not_found, not an empty shape.
    if (response.status === 404) return [];
    const result = unwrapOperatorResult(await response.json(), '/api/orchestrator/status');
    const owned = new Set(packetIds);
    return (result?.agents ?? []).filter((agent) => owned.has(agent?.packetId));
  }

  function worktreePaths() {
    return new Set(parseWorktreePaths(run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })));
  }

  function ownedPids() {
    return descendantPids(snapshot(run), rootPid);
  }

  return {
    async captureBaseline() {
      const pids = ownedPids();
      const response = await fetchImpl(`${apiBase}/api/orchestrator/status`, { headers });
      // Nothing of ours exists yet, so every live lane belongs to someone else.
      const activeLaneCount = response.status === 404
        ? 0
        : (unwrapOperatorResult(await response.json(), '/api/orchestrator/status')?.agents ?? [])
          .filter((agent) => isActiveLaneStatus(agent?.status)).length;
      return {
        activeLaneCount,
        worktrees: worktreePaths(),
        pids,
        ports: listeningPortsForPids(pids, run),
      };
    },

    // Creation is separate from dispatch so the caller owns the packet scope
    // before any launch can fail: teardown must never be blind to a packet that
    // was created but whose dispatch threw.
    async createScopedLanes(laneCount) {
      const clientMutationId = `footprint-load-${now()}`;
      const issues = Array.from({ length: laneCount }, (_, index) => ({
        number: index + 1,
        title: `footprint load lane ${index + 1}`,
        body: LOAD_TASK_BODY,
        url: '',
      }));
      const created = await post('/api/orchestrator/create-mission', {
        clientMutationId,
        repoPath,
        issues,
        runtime,
      });
      const missionId = created?.missionId ?? null;
      const packetIds = (created?.packets ?? []).map((packet) => packet.id).filter(Boolean);
      if (!missionId || packetIds.length !== laneCount) {
        throw new Error(`create-mission returned ${packetIds.length} packets for ${laneCount} requested lanes`);
      }
      // Scope is captured BEFORE dispatch so teardown can only ever touch the
      // packets this run created, even if the dispatch call fails mid-flight.
      return { missionId, packetIds };
    },

    async dispatchScopedLanes(scope) {
      await post('/api/orchestrator/dispatch', { missionId: scope.missionId, runtime, wait: false });
    },

    async waitForActiveLanes(scope, deadline = now() + limits.activationTimeoutMs) {
      while (now() < deadline) {
        const active = (await scopedAgents(scope.packetIds)).filter((agent) => isActiveLaneStatus(agent?.status));
        if (active.length >= scope.packetIds.length) return true;
        await sleep(limits.pollMs);
      }
      return false;
    },

    // Teardown runs the real stop lifecycle, packet by packet, for the packets
    // this run created. Stop confirms worker death, banks recoverable branch
    // state, and completes lane/worktree cleanup in the background. The harness
    // waits for that exact packet to leave the active set and never issues a Git
    // removal itself.
    async releaseScopedLanes(scope) {
      const dispositions = [];
      for (const packetId of scope.packetIds) {
        try {
          await post('/api/orchestrator/stop-packet', { packetId });
        } catch (error) {
          dispositions.push({ packetId, stage: 'stop', outcome: 'refused', message: String(error?.message ?? error) });
          continue;
        }
        // Stop acknowledges once the worker is confirmed dead, then completes
        // lane archival/worktree pruning in the background. Closing against
        // that still-running cleanup contends on the packet lifecycle lock and
        // can block indefinitely. Wait within the declared drain budget until
        // this exact packet leaves the active set; a timeout is a refusal, not
        // permission to race or delete the checkout ourselves.
        const stopDeadline = now() + limits.drainTimeoutMs;
        let stopSettled = false;
        while (now() < stopDeadline) {
          const active = (await scopedAgents([packetId])).some((agent) => isActiveLaneStatus(agent?.status));
          if (!active) {
            stopSettled = true;
            break;
          }
          await sleep(limits.pollMs);
        }
        if (!stopSettled) {
          dispositions.push({
            packetId,
            stage: 'stop',
            outcome: 'refused',
            message: `stop cleanup did not settle within ${limits.drainTimeoutMs}ms`,
          });
          continue;
        }
        dispositions.push({ packetId, stage: 'stop', outcome: 'stopped' });
      }
      const deadline = now() + limits.drainTimeoutMs;
      while (now() < deadline) {
        const active = (await scopedAgents(scope.packetIds)).filter((agent) => isActiveLaneStatus(agent?.status));
        if (active.length === 0) break;
        await sleep(limits.pollMs);
      }
      return dispositions;
    },

    async collectResiduals(baseline, scope) {
      const pids = ownedPids();
      const ports = listeningPortsForPids(pids, run);
      const survivingWorktrees = [...worktreePaths()].filter((worktree) => (
        !baseline.worktrees.has(worktree) && existsSync(worktree)
      ));
      const activeScoped = (await scopedAgents(scope.packetIds)).filter((agent) => isActiveLaneStatus(agent?.status));
      return {
        counts: {
          lanes: activeScoped.length,
          childProcesses: [...pids].filter((pid) => !baseline.pids.has(pid)).length,
          worktrees: survivingWorktrees.length,
          listeners: [...ports].filter((port) => !baseline.ports.has(port)).length,
        },
        // Preserved state is REPORTED, never removed. Identities are digests so
        // a release receipt can name what survived without publishing a path.
        preservedWorktrees: survivingWorktrees.map((worktree) => ({
          digest: redactedDigest(worktree),
          insideLoadRepo: path.resolve(worktree).startsWith(`${path.resolve(repoPath)}${path.sep}`),
        })),
        preservedLanes: activeScoped.map((agent) => ({
          packetDigest: redactedDigest(agent?.packetId ?? ''),
          status: String(agent?.status ?? 'unknown'),
        })),
      };
    },
  };
}

function residualTotal(residuals) {
  return Object.values(residuals.counts).reduce((sum, value) => sum + value, 0);
}

// Runs N real lanes against the isolated app, samples the loaded footprint, and
// then releases exactly the packets it created through the control plane. Any
// surviving state is preserved and reported as an explicit unavailable result —
// a leaked lane invalidates the measurement, and force-deleting a worktree that
// may hold unpushed work is never an acceptable way to make a gate green.
export async function runLoadScenario({ plan, driver, sample }) {
  if (!plan.available) return plan;
  const baseline = await driver.captureBaseline();
  if (baseline.activeLaneCount > 0) {
    return unavailable(LOAD_UNAVAILABLE_REASONS.preExistingLanes, { activeLaneCount: baseline.activeLaneCount });
  }

  let scope = { missionId: null, packetIds: [] };
  let samples = [];
  let missedActivation = false;
  let dispositions = [];
  let residuals;
  try {
    scope = await driver.createScopedLanes(plan.laneCount);
    await driver.dispatchScopedLanes(scope);
    if (await driver.waitForActiveLanes(scope)) {
      samples = await sample({ laneCount: plan.laneCount });
    } else {
      missedActivation = true;
    }
  } finally {
    dispositions = await driver.releaseScopedLanes(scope);
    residuals = await driver.collectResiduals(baseline, scope);
  }

  const teardown = {
    packetCount: scope.packetIds.length,
    stopped: dispositions.filter((entry) => entry.outcome === 'stopped').length,
    refused: dispositions.filter((entry) => entry.outcome === 'refused').length,
    residuals,
  };

  if (residualTotal(residuals) > 0) {
    return { ...unavailable(LOAD_UNAVAILABLE_REASONS.residualStatePreserved), laneCount: plan.laneCount, teardown };
  }
  if (missedActivation) {
    return { ...unavailable(LOAD_UNAVAILABLE_REASONS.lanesDidNotReachActive), laneCount: plan.laneCount, teardown };
  }

  return {
    available: true,
    laneCount: plan.laneCount,
    runtime: plan.runtime,
    sampleCount: samples.length,
    samples: samples.map((entry, index) => ({
      index,
      recordedAt: entry.recordedAt,
      metrics: entry.metrics,
      verdict: entry.verdict,
      checks: entry.checks,
    })),
    aggregate: summarizeFootprintSamples(samples),
    teardown,
  };
}
