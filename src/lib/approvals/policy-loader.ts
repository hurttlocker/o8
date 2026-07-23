import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { ApprovalRisk, PolicyRule, PolicyRuleOverride } from '@/lib/approvals/types';
import { getDataDir } from '@/lib/data-dir-migration';

export const POLICIES_DIR = getDataDir();
export const POLICIES_PATH = path.join(POLICIES_DIR, 'policies.json');

interface ParsedPolicyRules {
  ok: boolean;
  rules: PolicyRuleOverride[];
  error?: string;
}

function isApprovalRisk(value: unknown): value is ApprovalRisk {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isPolicyRuleOverride(value: unknown): value is PolicyRuleOverride {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && (candidate.name === undefined || typeof candidate.name === 'string')
    && (candidate.description === undefined || typeof candidate.description === 'string')
    && (candidate.risk === undefined || isApprovalRisk(candidate.risk))
    && (candidate.blocked === undefined || typeof candidate.blocked === 'boolean')
    && (candidate.workspacePath === undefined || typeof candidate.workspacePath === 'string')
    && (candidate.enabled === undefined || typeof candidate.enabled === 'boolean')
    && (candidate.requiresApproval === undefined || typeof candidate.requiresApproval === 'boolean');
}

export function parsePolicyRules(value: unknown): ParsedPolicyRules {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      rules: [],
      error: 'policies must be an array',
    };
  }

  const rules: PolicyRuleOverride[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isPolicyRuleOverride(entry)) {
      return {
        ok: false,
        rules: [],
        error: `policies[${index}] is invalid`,
      };
    }
    rules.push(entry);
  }

  return { ok: true, rules };
}

export function loadUserPolicies(): PolicyRuleOverride[] {
  if (!existsSync(POLICIES_PATH)) {
    return [];
  }

  try {
    const raw = JSON.parse(readFileSync(POLICIES_PATH, 'utf8')) as unknown;
    const parsed = parsePolicyRules(raw);
    if (!parsed.ok) {
      console.warn(`[policy] Ignoring invalid policies file: ${parsed.error}`);
      return [];
    }
    return parsed.rules;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read policies file';
    console.warn(`[policy] ${message}`);
    return [];
  }
}

export function mergePolicies(defaults: PolicyRule[], overrides: PolicyRuleOverride[]): PolicyRule[] {
  const overridesById = new Map(
    overrides
      .filter((rule) => !rule.workspacePath?.trim())
      .map((rule) => [rule.id, rule]),
  );
  return defaults.map((rule) => {
    const override = overridesById.get(rule.id);
    return override ? { ...rule, ...override } : rule;
  });
}

export function writeUserPolicies(rules: PolicyRuleOverride[]) {
  mkdirSync(POLICIES_DIR, { recursive: true });
  writeFileSync(POLICIES_PATH, `${JSON.stringify(rules, null, 2)}\n`, 'utf8');
}

export function watchPolicies(callback: (rules: PolicyRuleOverride[]) => void): () => void {
  let fileWatcher: FSWatcher | null = null;
  let dirWatcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;

  const scheduleReload = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      callback(loadUserPolicies());
    }, 150);
  };

  const attachFileWatcher = () => {
    if (fileWatcher || !existsSync(POLICIES_PATH)) {
      return;
    }

    try {
      fileWatcher = watch(POLICIES_PATH, () => {
        scheduleReload();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to watch policies file';
      console.warn(`[policy] ${message}`);
    }
  };

  const attachDirectoryWatcher = () => {
    if (dirWatcher || !existsSync(POLICIES_DIR)) {
      return;
    }

    try {
      dirWatcher = watch(POLICIES_DIR, (_eventType, fileName) => {
        if (fileName?.toString() !== 'policies.json') {
          return;
        }
        attachFileWatcher();
        scheduleReload();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to watch policies directory';
      console.warn(`[policy] ${message}`);
    }
  };

  attachFileWatcher();
  attachDirectoryWatcher();

  return () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    fileWatcher?.close();
    dirWatcher?.close();
  };
}
