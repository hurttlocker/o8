import 'server-only';

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { addRepo } from '@/lib/repos/registry';
import { reconcileProjectsWithRegistry } from '@/lib/repos/projects';
import { triggerScan, startChangePolling } from '@/lib/skeleton/autoscan';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const execFileAsync = promisify(execFile);

export type ScaffoldKind = 'nextjs' | 'node' | 'static-html' | 'python';

interface RegisteredBootstrapRepo {
  repo: RepoRegistryEntry;
  projectId: string | null;
}

interface InitRepoResult extends RegisteredBootstrapRepo {
  initialized: boolean;
  initialCommit: boolean;
}

interface ScaffoldRepoResult extends RegisteredBootstrapRepo {
  scaffolded: boolean;
  kind: ScaffoldKind;
  filesWritten: string[];
  skippedFiles: string[];
  committed: boolean;
}

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function resolveTargetPath(inputPath: string): string {
  const expanded = expandHomePath(inputPath);
  if (!expanded) {
    throw new Error('repo path is required');
  }
  return path.resolve(expanded);
}

function slugifyName(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `o8-project-${randomUUID().slice(0, 6)}`;
}

function packageNameFromPath(repoPath: string, name?: string): string {
  return slugifyName(name?.trim() || path.basename(repoPath));
}

function pythonPackageName(repoPath: string, name?: string): string {
  return packageNameFromPath(repoPath, name).replace(/-/g, '_');
}

async function ensureDirectory(repoPath: string): Promise<void> {
  const existing = await stat(repoPath).catch(() => null);
  if (existing && !existing.isDirectory()) {
    throw new Error('repo path must be a directory');
  }
  await mkdir(repoPath, { recursive: true });
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 20_000,
  });
  return stdout.trim();
}

async function runGitCommit(repoPath: string, message: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        '-c',
        'user.name=o8',
        '-c',
        'user.email=o8@local',
        'commit',
        '-m',
        message,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

async function hasCommit(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitRepo(repoPath: string): Promise<boolean> {
  if (await isGitRepo(repoPath)) {
    return false;
  }
  try {
    await execFileAsync('git', ['init', '-b', 'main', repoPath], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
  } catch {
    await execFileAsync('git', ['init', repoPath], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
    await runGit(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  return true;
}

async function writeFileIfMissing(
  repoPath: string,
  relativePath: string,
  contents: string,
  filesWritten: string[],
  skippedFiles: string[],
): Promise<void> {
  const filePath = path.join(repoPath, relativePath);
  const existing = await stat(filePath).catch(() => null);
  if (existing) {
    skippedFiles.push(relativePath);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
  filesWritten.push(relativePath);
}

async function ensureInitialCommit(repoPath: string, name?: string): Promise<boolean> {
  if (await hasCommit(repoPath)) {
    return false;
  }
  const filename = name?.trim() ? 'README.md' : '.gitkeep';
  const contents = name?.trim() ? `# ${name.trim()}\n` : '';
  const filePath = path.join(repoPath, filename);
  if (!(await stat(filePath).catch(() => null))) {
    await writeFile(filePath, contents, 'utf8');
  }
  await runGit(repoPath, ['add', '--', filename]);
  const committed = await runGitCommit(repoPath, 'chore: initialize repository');
  if (!committed) {
    throw new Error('Failed to create the initial git commit.');
  }
  return true;
}

function normalizeScaffoldKind(kind: string): ScaffoldKind {
  const normalized = kind.trim().toLowerCase();
  if (normalized === 'next' || normalized === 'nextjs') return 'nextjs';
  if (normalized === 'static' || normalized === 'static-web' || normalized === 'static-html') return 'static-html';
  if (normalized === 'node' || normalized === 'nodejs') return 'node';
  if (normalized === 'python' || normalized === 'py') return 'python';
  throw new Error('kind must be one of nextjs, node, static-html, python');
}

function scaffoldTemplates(repoPath: string, kind: ScaffoldKind, name?: string): Array<[string, string]> {
  const packageName = packageNameFromPath(repoPath, name);
  const pyName = pythonPackageName(repoPath, name);
  const displayName = (name?.trim() || packageName).replace(/[<>{}`$\\]/g, '').trim() || packageName;

  if (kind === 'static-html') {
    return [[
      'index.html',
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${displayName}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif; background: #f6f7f2; color: #1d2433; }
      main { text-align: center; padding: 48px; }
      h1 { margin: 0 0 12px; font-size: clamp(40px, 8vw, 88px); letter-spacing: 0; }
      p { margin: 0; font-size: 18px; color: #526071; }
    </style>
  </head>
  <body>
    <main>
      <h1>Hello world</h1>
      <p>${displayName} is ready.</p>
    </main>
  </body>
</html>
`,
    ]];
  }

  if (kind === 'node') {
    return [
      ['package.json', `${JSON.stringify({
        name: packageName,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'tsx src/index.ts',
          build: 'tsc',
          start: 'node dist/index.js',
        },
        devDependencies: {
          '@types/node': '^20.0.0',
          tsx: '^4.0.0',
          typescript: '^5.0.0',
        },
      }, null, 2)}\n`],
      ['tsconfig.json', `${JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'dist',
          rootDir: 'src',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      }, null, 2)}\n`],
      ['src/index.ts', 'console.log(\'Hello world from o8.\');\n'],
    ];
  }

  if (kind === 'python') {
    return [
      ['pyproject.toml', `[project]
name = "${packageName}"
version = "0.1.0"
requires-python = ">=3.11"

[tool.pytest.ini_options]
pythonpath = ["src"]
`],
      [`src/${pyName}/__init__.py`, '"""Project package."""\n'],
      [`src/${pyName}/main.py`, 'def main() -> None:\n    print("Hello world from o8.")\n\n\nif __name__ == "__main__":\n    main()\n'],
    ];
  }

  return [
    ['package.json', `${JSON.stringify({
      name: packageName,
      version: '0.1.0',
      private: true,
      scripts: {
        dev: 'next dev',
        build: 'next build',
        start: 'next start',
        lint: 'next lint',
      },
      dependencies: {
        next: 'latest',
        react: 'latest',
        'react-dom': 'latest',
      },
      devDependencies: {
        '@types/node': '^20.0.0',
        '@types/react': '^18.0.0',
        '@types/react-dom': '^18.0.0',
        typescript: '^5.0.0',
      },
    }, null, 2)}\n`],
    ['tsconfig.json', `${JSON.stringify({
      compilerOptions: {
        target: 'ES2017',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        plugins: [{ name: 'next' }],
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules'],
    }, null, 2)}\n`],
    ['next-env.d.ts', '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// This file is generated by o8 scaffold.\n'],
    ['src/app/layout.tsx', `import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: ${JSON.stringify(displayName)},
  description: 'Scaffolded by o8',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`],
    ['src/app/page.tsx', `export default function Page() {
  return (
    <main style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, system-ui, sans-serif',
      background: '#f6f7f2',
      color: '#1d2433',
    }}>
      <section style={{ textAlign: 'center', padding: 48 }}>
        <h1 style={{ margin: '0 0 12px', fontSize: 64, letterSpacing: 0 }}>Hello world</h1>
        <p style={{ margin: 0, fontSize: 18, color: '#526071' }}>{${JSON.stringify(`${displayName} is ready.`)}}</p>
      </section>
    </main>
  );
}
`],
  ];
}

async function registerRepo(repoPath: string): Promise<RegisteredBootstrapRepo> {
  const repo = await addRepo(repoPath);
  triggerScan(repo.localPath);
  startChangePolling(repo.localPath);
  const ledger = await reconcileProjectsWithRegistry();
  const project = ledger.projects.find((entry) => (
    entry.repoPaths.some((candidate) => path.resolve(candidate) === path.resolve(repo.localPath))
  ));
  return { repo, projectId: project?.id ?? ledger.activeProjectId ?? null };
}

export async function initRepo(inputPath: string, name?: string): Promise<InitRepoResult> {
  const repoPath = resolveTargetPath(inputPath);
  await ensureDirectory(repoPath);
  const initialized = await ensureGitRepo(repoPath);
  const initialCommit = await ensureInitialCommit(repoPath, name);
  const registered = await registerRepo(repoPath);
  return { ...registered, initialized, initialCommit };
}

export async function scaffoldRepo(inputPath: string, rawKind: string, name?: string): Promise<ScaffoldRepoResult> {
  const repoPath = resolveTargetPath(inputPath);
  const kind = normalizeScaffoldKind(rawKind);
  await ensureDirectory(repoPath);
  await ensureGitRepo(repoPath);

  const filesWritten: string[] = [];
  const skippedFiles: string[] = [];
  for (const [relativePath, contents] of scaffoldTemplates(repoPath, kind, name)) {
    await writeFileIfMissing(repoPath, relativePath, contents, filesWritten, skippedFiles);
  }

  let committed = false;
  if (filesWritten.length > 0) {
    await runGit(repoPath, ['add', '--', ...filesWritten]);
    committed = await runGitCommit(repoPath, `chore: scaffold ${kind} project`);
    if (!committed) {
      throw new Error('Failed to commit scaffold files.');
    }
  } else {
    committed = await ensureInitialCommit(repoPath, name);
  }

  const registered = await registerRepo(repoPath);
  return {
    ...registered,
    scaffolded: filesWritten.length > 0,
    kind,
    filesWritten,
    skippedFiles,
    committed,
  };
}
