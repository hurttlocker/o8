#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { resolveApproval } from '../src/lib/approvals/resolution';
import { createApproval } from '../src/lib/approvals/store';

type GateOutcome = 'PASS' | 'FAIL' | 'BYPASS';

interface CapturedConsoleError {
  message: string;
  source: string;
  lineno: number;
}

interface PreshipGateAuditPayload {
  outcome: GateOutcome;
  version: string;
  gitSha: string;
  mode: 'authoritative';
  dashboardRoute?: string;
  interactiveElapsedMs?: number;
  nodeVersion: string;
  signalFailed?: string;
  capturedConsoleErrors?: CapturedConsoleError[];
  childStderrTail?: string;
  overrideReason?: string;
  operatorUser?: string;
}

function stringMetadata(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function descriptionFor(payload: PreshipGateAuditPayload): string {
  if (payload.outcome === 'PASS') {
    return 'The real macOS WKWebView booted the signed o8.app, rendered the dashboard, and reported no uncaught webview errors.';
  }
  if (payload.outcome === 'BYPASS') {
    return 'The operator bypassed the real macOS WKWebView pre-ship boot gate with an explicit reason.';
  }
  return 'The real macOS WKWebView pre-ship boot gate failed before release upload.';
}

function createGateApproval(payload: PreshipGateAuditPayload) {
  const sessionKey = `boot-gate:v${payload.version}`;
  const common = {
    source: 'runtime' as const,
    runtime: 'boot-gate',
    agent: 'preship-webview-gate',
    sessionKey,
    description: descriptionFor(payload),
  };

  if (payload.outcome === 'PASS') {
    return createApproval({
      ...common,
      title: `Boot gate PASSED - o8 v${payload.version}`,
      summary: 'WKWebView boot gate passed',
      risk: 'low',
      metadata: stringMetadata({
        version: payload.version,
        gitSha: payload.gitSha,
        mode: payload.mode,
        dashboardRoute: payload.dashboardRoute ?? '/dashboard',
        consoleErrorCount: 0,
        interactiveElapsedMs: payload.interactiveElapsedMs,
        nodeVersion: payload.nodeVersion,
      }),
    });
  }

  if (payload.outcome === 'BYPASS') {
    return createApproval({
      ...common,
      title: `Boot gate BYPASSED - shipped v${payload.version} without the WKWebView check`,
      summary: 'WKWebView boot gate bypassed',
      risk: 'high',
      metadata: stringMetadata({
        version: payload.version,
        gitSha: payload.gitSha,
        overrideReason: payload.overrideReason,
        operatorUser: payload.operatorUser,
      }),
    });
  }

  return createApproval({
    ...common,
    title: `Boot gate FAILED - o8 v${payload.version}`,
    summary: 'WKWebView boot gate failed',
    risk: 'high',
    metadata: stringMetadata({
      version: payload.version,
      gitSha: payload.gitSha,
      signalFailed: payload.signalFailed,
    }),
    args: {
      capturedConsoleErrors: payload.capturedConsoleErrors ?? [],
      childStderrTail: payload.childStderrTail ?? '',
    },
  });
}

async function main(): Promise<void> {
  const raw = readFileSync(0, 'utf8').trim();
  if (!raw) {
    throw new Error('missing audit payload on stdin');
  }

  const payload = JSON.parse(raw) as PreshipGateAuditPayload;
  const approval = createGateApproval(payload);

  if (payload.outcome === 'PASS') {
    resolveApproval(approval.id, 'approve', 'desktop', 'WKWebView boot gate passed before release upload.');
  } else if (payload.outcome === 'BYPASS') {
    resolveApproval(approval.id, 'approve', 'desktop', `Bypass accepted: ${payload.overrideReason ?? 'no reason recorded'}`);
  } else {
    resolveApproval(approval.id, 'reject', 'desktop', `WKWebView boot gate failed: ${payload.signalFailed ?? 'unknown'}`);
  }
}

void main().catch((error) => {
  console.error('[preship-gate-audit] failed:', error);
  process.exitCode = 1;
});
