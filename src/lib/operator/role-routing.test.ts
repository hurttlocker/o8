import { describe, expect, it } from 'vitest';

import { MODEL_IDS } from '@/lib/models';
import {
  projectAgentRoleRoutes,
  validateRuntimeModelSelection,
  type RoleRoutingDefaults,
  type RoleRoutingSources,
  type RuntimeRouteAvailability,
} from './role-routing';

const defaults: RoleRoutingDefaults = {
  subscriptionProfile: 'both',
  orchestratorBackend: 'auto',
  inAppOrchestratorEnabled: true,
  thinkingEffort: 'max',
  orchestratorModel: MODEL_IDS.orchestratorDefault,
  opencodeOrchestratorModel: null,
  reviewerBackend: 'follow',
  defaultDispatchRuntime: 'codex',
  defaultDispatchModel: '',
  codexWorkerEffort: 'adaptive',
  claudeWorkerEffort: 'adaptive',
  crossHouseWorkerFallback: false,
  classAComposer: 'auto',
  brainUseClaudeCli: true,
  brainCodexModel: MODEL_IDS.codexWorkerDefault,
  brainCodexEffort: 'xhigh',
  localInferenceBaseUrl: '',
  localChatModel: '',
  targetingTriage: {
    runtime: 'codex',
    model: '',
    effort: 'low',
  },
};

const sources: RoleRoutingSources = {
  subscriptionProfile: 'file',
  orchestratorBackend: 'default',
  inAppOrchestratorEnabled: 'file',
  thinkingEffort: 'default',
  orchestratorModel: 'default',
  opencodeOrchestratorModel: 'default',
  reviewerBackend: 'default',
  defaultDispatchRuntime: 'file',
  defaultDispatchModel: 'default',
  codexWorkerEffort: 'default',
  claudeWorkerEffort: 'default',
  crossHouseWorkerFallback: 'default',
  classAComposer: 'default',
  brainUseClaudeCli: 'file',
  brainCodexModel: 'default',
  brainCodexEffort: 'default',
  localInferenceBaseUrl: 'default',
  localChatModel: 'default',
  targetingTriage: 'file',
};

const availability: RuntimeRouteAvailability[] = [
  {
    id: 'codex',
    label: 'Codex',
    available: true,
    unavailableReason: null,
    detail: 'Codex is installed and signed in.',
    fix: '',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    available: true,
    unavailableReason: null,
    detail: 'Claude Code is installed and signed in.',
    fix: '',
  },
];

function project(
  overrides: Partial<RoleRoutingDefaults> = {},
  routeAvailability = availability,
) {
  return projectAgentRoleRoutes({
    values: { ...defaults, ...overrides },
    sources,
    dispatchableRuntimes: routeAvailability,
  });
}

describe('projectAgentRoleRoutes', () => {
  it('projects every operator-facing role in stable order', () => {
    expect(project().map((route) => route.id)).toEqual([
      'orchestrate',
      'build',
      'review',
      'brain',
      'triage',
      'recovery',
    ]);
  });

  it('distinguishes configured Auto/Follow choices from their effective runtime', () => {
    const routes = project();
    const orchestrate = routes[0];
    const review = routes[2];

    expect(orchestrate.configured.backend).toBe('auto');
    expect(orchestrate.effective).toMatchObject({
      backend: 'claude',
      runtime: 'claude-code',
      model: MODEL_IDS.orchestratorDefault,
    });
    expect(orchestrate.sources.backend).toBe('default');
    expect(orchestrate.reason).toContain('legacy orchestrator preference');
    expect(orchestrate.availability.status).toBe('ready');

    expect(review.configured.backend).toBe('follow');
    expect(review.effective.backend).toBe('claude');
    expect(review.effective.runtime).toBe('claude-code');
    expect(review.reason).toContain('follows Orchestrate');
  });

  it('surfaces subscription-profile ownership for constrained roles', () => {
    const routes = projectAgentRoleRoutes({
      values: {
        ...defaults,
        subscriptionProfile: 'codex-only',
        orchestratorBackend: 'codex',
        defaultDispatchRuntime: 'codex',
        reviewerBackend: 'codex',
      },
      sources: {
        ...sources,
        orchestratorBackend: 'profile',
        defaultDispatchRuntime: 'profile',
        reviewerBackend: 'profile',
      },
      dispatchableRuntimes: availability,
    });

    expect(routes[0].sources.backend).toBe('profile');
    expect(routes[0].reason).toContain('Codex-only');
    expect(routes[1].sources.runtime).toBe('profile');
    expect(routes[1].reason).toContain('controls this route');
    expect(routes[2].sources.backend).toBe('profile');
  });

  it('preserves environment ownership in the role projection', () => {
    const routes = projectAgentRoleRoutes({
      values: defaults,
      sources: {
        ...sources,
        orchestratorBackend: 'env',
        defaultDispatchRuntime: 'env',
        reviewerBackend: 'env',
      },
      dispatchableRuntimes: availability,
    });

    expect(routes[0].sources.backend).toBe('env');
    expect(routes[1].sources.runtime).toBe('env');
    expect(routes[2].sources.backend).toBe('env');
  });

  it('lets Review use a different pinned runtime than Orchestrate', () => {
    const review = project({ reviewerBackend: 'codex' })[2];

    expect(review.configured.backend).toBe('codex');
    expect(review.effective).toMatchObject({ backend: 'codex', runtime: 'codex' });
    expect(review.reason).toContain('pinned for review');
  });

  it('shows the adapter default as effective without pretending it was configured', () => {
    const build = project()[1];

    expect(build.configured).toMatchObject({
      runtime: 'codex',
      model: null,
    });
    expect(build.effective.model).toBe(MODEL_IDS.codexWorkerDefault);
    expect(build.sources.runtime).toBe('file');
    expect(build.sources.model).toBe('runtime-default');
    expect(build.reason).toContain('runtime default');
  });

  it('keeps Recovery tied to the packet worker route and its readiness', () => {
    const build = project()[1];
    const recovery = project()[5];

    expect(recovery.configured.backend).toBe('packet-worker');
    expect(recovery.effective).toEqual(build.effective);
    expect(recovery.sources.runtime).toBe('derived');
    expect(recovery.reason).toContain('persisted worker route');
    expect(recovery.availability).toEqual(build.availability);
  });

  it('surfaces a pinned Brain CLI that cannot launch and names its fallback', () => {
    const routes = project(
      { classAComposer: 'sonnet-cli' },
      availability.map((item) => item.id === 'claude-code'
        ? {
            ...item,
            available: false,
            unavailableReason: 'needs_auth' as const,
            detail: 'Claude Code is installed but not signed in.',
            fix: 'Sign in from the CLI.',
          }
        : item),
    );
    const brain = routes[3];

    expect(brain.effective).toMatchObject({
      runtime: 'claude-code',
      model: 'sonnet',
    });
    expect(brain.availability).toMatchObject({
      status: 'unavailable',
      reason: 'needs_auth',
      fix: 'Sign in from the CLI.',
    });
    expect(brain.fallbacks.join(' ')).toContain('Codex');
  });

  it('reports an incompatible legacy worker model while projecting the safe adapter default', () => {
    const build = project({ defaultDispatchModel: MODEL_IDS.orchestratorDefault })[1];

    expect(build.configured.model).toBe(MODEL_IDS.orchestratorDefault);
    expect(build.effective.model).toBe(MODEL_IDS.codexWorkerDefault);
    expect(build.availability.status).toBe('unavailable');
    expect(build.reason).toContain('cannot launch');
  });
});

describe('validateRuntimeModelSelection', () => {
  it('rejects cross-house combinations before settings are persisted', () => {
    expect(validateRuntimeModelSelection('codex', MODEL_IDS.orchestratorDefault, 'Default worker'))
      .toBe(`Default worker model "${MODEL_IDS.orchestratorDefault}" is not compatible with Codex.`);
  });

  it('accepts adapter defaults, matching models, multi-provider models, and Codex local models', () => {
    expect(validateRuntimeModelSelection('codex', '', 'Default worker')).toBeNull();
    expect(validateRuntimeModelSelection('codex', MODEL_IDS.codexWorkerDefault, 'Default worker')).toBeNull();
    expect(validateRuntimeModelSelection('opencode', 'anthropic/custom-model', 'Default worker')).toBeNull();
    expect(validateRuntimeModelSelection('codex', 'ollama:qwen2.5-coder:32b', 'Default worker')).toBeNull();
    expect(validateRuntimeModelSelection('claude-code', 'some-model', 'Default worker')).toBeNull();
  });
});
