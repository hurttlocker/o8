/**
 * Directive types — operator-authored rules injected into agent sessions.
 *
 * Directives are markdown files with YAML frontmatter, stored in
 * ~/.cortex-ide/directives/ and indexed in SQLite for fast lookup.
 */

export type DirectiveScope = 'global' | 'repo';

export interface Directive {
  id: string;
  title: string;
  scope: DirectiveScope;
  /** Repo name (from repos.json) when scope is 'repo' */
  repoName: string | null;
  /** Lower = higher priority (injected first). Default 50. */
  priority: number;
  /** Markdown body content */
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDirectiveInput {
  title: string;
  scope: DirectiveScope;
  repoName?: string | null;
  priority?: number;
  content: string;
}

export interface UpdateDirectiveInput {
  title?: string;
  scope?: DirectiveScope;
  repoName?: string | null;
  priority?: number;
  content?: string;
}

export interface DirectiveBlock {
  text: string;
  tokenEstimate: number;
  directiveCount: number;
}
