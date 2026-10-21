import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Existing boundaries outside this migration remain explicit, reviewable debt.
// Host-repository calls do not match the lane-cwd heuristic and need no entry.
const ALLOWLIST: Record<string, string> = {};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file)
      : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

export function rawLaneGitCalls(file: string, source: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)
      && /(?:execFile|spawn|materializationAwareExecFile)/.test(node.expression.getText(ast))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'git') {
      const options = node.arguments.slice(1).find(ts.isObjectLiteralExpression);
      const cwd = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) => property.name?.getText(ast) === 'cwd')
        : undefined;
      const args = node.arguments[1]?.getText(ast) ?? '';
      if ((cwd && /worktreePath|reviewCwd|laneCwd/i.test(cwd.getText(ast)))
        || (/['"]-C['"]/.test(args) && /worktreePath|reviewCwd|laneCwd/i.test(args))) {
        calls.push(`${file}:${node.expression.getText(ast)}:${cwd?.getText(ast) ?? args}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return calls;
}

describe('lane Git subprocess guard', () => {
  it('rejects raw Git with a lane cwd outside the hardened helper', () => {
    const calls = ['src/lib/lane', 'src/lib/supervisor'].flatMap(sourceFiles)
      .filter((file) => file !== 'src/lib/lane/lane-git.ts')
      .flatMap((file) => rawLaneGitCalls(file, readFileSync(file, 'utf8')));
    expect(calls.filter((call) => !ALLOWLIST[call])).toEqual([]);
    expect(Object.keys(ALLOWLIST).filter((call) => !calls.includes(call))).toEqual([]);
  });

  it('recognizes multiline, shorthand, synchronous and spawn forms', () => {
    expect(rawLaneGitCalls('fixture.ts', `
      execFile('git', ['status'], { cwd: lane.worktreePath });
      execFileAsync('git', ['diff'], {\n cwd: reviewCwd });
      execFileSync('git', ['rev-parse', 'HEAD'], { laneCwd, cwd: laneCwd });
      spawn('git', ['status'], { cwd: worktreePath });
      spawn('git', { cwd: laneCwd });
      execFileSync('git', { cwd: worktreePath });
      execFile('git', ['status'], { cwd: lane.repoPath });
    `)).toHaveLength(6);
  });
});
