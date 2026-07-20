import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const reviewerMocks = vi.hoisted(() => ({
  askClaudeWarm: vi.fn(),
  prewarmClaudeRepl: vi.fn(),
  callCodex: vi.fn(),
}));

vi.mock('@/lib/claude-code/warm-repl-pool', () => ({
  askClaudeWarm: reviewerMocks.askClaudeWarm,
  prewarmClaudeRepl: reviewerMocks.prewarmClaudeRepl,
}));
vi.mock('@/lib/claude-code/one-shot-repl', () => ({
  defaultClaudeBin: () => '/mock/claude',
}));
vi.mock('@/lib/cortex/qa/llm/codex-adapter', () => ({
  callCodex: reviewerMocks.callCodex,
}));

import * as repoSpecRoute from '@/app/api/repo-spec/route';
import { appendComment, insertSuggestion } from '@/lib/o8md/mutate';
import { appendRoughdraftReply, extractRoughdraftReviewIndex } from '@/lib/o8md/rfm';

const tempRepos: string[] = [];

function tempRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-repo-spec-note-action-'));
  tempRepos.push(repoPath);
  return repoPath;
}

function actionRequest(repoPath: string, action: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `http://localhost:3001/api/repo-spec?action=${encodeURIComponent(action)}&repoPath=${encodeURIComponent(repoPath)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

describe('repo-spec single-note actions', () => {
  beforeEach(() => {
    reviewerMocks.askClaudeWarm.mockReset();
    reviewerMocks.prewarmClaudeRepl.mockReset();
    reviewerMocks.callCodex.mockReset();
  });

  afterEach(() => {
    while (tempRepos.length > 0) {
      const repoPath = tempRepos.pop();
      if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it('scopes the real reviewer turn to one note and anchor without regenerating annotations', async () => {
    const repoPath = tempRepo();
    const specPath = join(repoPath, 'o8.md');
    let content = [
      '# Plan',
      'PRIVATE FULL-DOC CONTEXT MUST NOT ENTER THE TURN.',
      'Ship the focused workflow.',
      'Unrelated section with another note.',
    ].join('\n');
    content = appendComment(content, {
      anchor: 'Ship the focused workflow.',
      body: 'Should this become a tracked action?',
      author: 'AI',
    });
    content = appendComment(content, {
      anchor: 'Unrelated section with another note.',
      body: 'This unrelated annotation must stay untouched.',
      author: 'AI',
    });
    const seededTarget = extractRoughdraftReviewIndex(content).items.find(
      (item) => item.text === 'Should this become a tracked action?',
    );
    content = appendRoughdraftReply(content, {
      parentId: seededTarget!.id,
      message: 'An earlier reply must remain first.',
      author: 'user',
    });
    writeFileSync(specPath, content, 'utf-8');
    const before = extractRoughdraftReviewIndex(content);
    const target = before.items.find((item) => item.text === 'Should this become a tracked action?');
    expect(target?.id).toBeTruthy();
    reviewerMocks.askClaudeWarm.mockResolvedValue('Yes. File one focused ticket and keep the other note unchanged.');

    const response = await repoSpecRoute.POST(actionRequest(repoPath, 'scoped-reply', {
      parentId: target!.id,
      message: 'What is the smallest useful next step?',
      content,
    }));
    const payload = await response.json() as { ok?: boolean; content?: string };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(reviewerMocks.askClaudeWarm).toHaveBeenCalledTimes(1);
    const prompt = String(reviewerMocks.askClaudeWarm.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('Ship the focused workflow.');
    expect(prompt).toContain('Should this become a tracked action?');
    expect(prompt).toContain('What is the smallest useful next step?');
    expect(prompt).not.toContain('PRIVATE FULL-DOC CONTEXT MUST NOT ENTER THE TURN.');
    expect(prompt).not.toContain('This unrelated annotation must stay untouched.');

    const persisted = readFileSync(specPath, 'utf-8');
    const after = extractRoughdraftReviewIndex(persisted);
    expect(after.summary.comments).toBe(before.summary.comments);
    expect(after.summary.suggestions).toBe(before.summary.suggestions);
    expect(after.summary.replies).toBe(before.summary.replies + 2);
    expect(after.items.filter((item) => item.kind === 'comment').map((item) => item.id))
      .toEqual(before.items.filter((item) => item.kind === 'comment').map((item) => item.id));
    expect(after.items.filter((item) => item.parentId === target!.id).map((item) => item.text))
      .toEqual([
        'An earlier reply must remain first.',
        'What is the smallest useful next step?',
        'Yes. File one focused ticket and keep the other note unchanged.',
      ]);
  });

  it('accepts one suggestion through the route and writes the edit at its anchor', async () => {
    const repoPath = tempRepo();
    const specPath = join(repoPath, 'o8.md');
    const content = insertSuggestion('# Plan\nShip the old workflow.\n', {
      kind: 'sub',
      anchor: 'Ship the old workflow.',
      replacement: 'Ship the focused workflow.',
      author: 'AI',
    });
    writeFileSync(specPath, content, 'utf-8');
    const suggestion = extractRoughdraftReviewIndex(content).items.find((item) => item.kind === 'suggestion');
    expect(suggestion?.id).toBeTruthy();

    const response = await repoSpecRoute.POST(actionRequest(repoPath, 'apply-suggestion', {
      targetId: suggestion!.id,
      content,
    }));

    expect(response.status).toBe(200);
    expect(readFileSync(specPath, 'utf-8')).toBe('# Plan\nShip the focused workflow.\n');
    expect(extractRoughdraftReviewIndex(readFileSync(specPath, 'utf-8')).summary.suggestions).toBe(0);
    expect(reviewerMocks.askClaudeWarm).not.toHaveBeenCalled();
  });
});
