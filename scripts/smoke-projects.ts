/**
 * Smoke test for the Projects foundation (epic #899).
 *
 * Exercises the full storage layer in a fresh data directory:
 *   create → add 2 repos with roles → list → set role → remove repo → delete
 *
 * Usage:
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-projects.ts
 *
 * Per CLAUDE.md "Dispatch smoke-test pattern": runs the script as a file
 * (`npx tsx <script>`), never via `tsx -e "import(...)"`. Named exports come
 * back as `undefined` through `tsx -e` because of the CJS namespace shim.
 */

import {
  addRepoToProject,
  createProject,
  deleteProject,
  getProject,
  isDismissed,
  listProjects,
  listProjectsByRepoId,
  recordDismissedSuggestion,
  removeRepoFromProject,
  setRepoRole,
  updateProject,
} from '../src/lib/projects/store';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function step(label: string, fn: () => void): void {
  process.stdout.write(`• ${label} … `);
  try {
    fn();
    process.stdout.write('ok\n');
  } catch (err) {
    process.stdout.write('FAIL\n');
    throw err;
  }
}

const project = createProject({
  name: 'O8 Suite',
  description: 'cortex-ide + landing site + mobile, grouped as one product',
});

step('createProject returns shape', () => {
  assert(project.id.startsWith('proj-'), 'id prefix proj-');
  assert(project.slug === 'o8-suite', `slug should be o8-suite, got ${project.slug}`);
  assert(project.name === 'O8 Suite', 'name preserved');
  assert(project.description !== null, 'description set');
  assert(typeof project.createdAt === 'number', 'createdAt is number');
});

step('getProject finds the row', () => {
  const fetched = getProject(project.id);
  assert(fetched, 'getProject returned null');
  assert(fetched.slug === 'o8-suite', 'slug round-trips');
});

step('addRepoToProject adds 2 repos with roles', () => {
  const link1 = addRepoToProject(project.id, 'repo-cortex-ide', 'fullstack', 'manual');
  const link2 = addRepoToProject(project.id, 'repo-o8-site', 'site', 'manual');
  assert(link1.repoId === 'repo-cortex-ide', 'repo1 id');
  assert(link1.role === 'fullstack', `repo1 role got ${link1.role}`);
  assert(link2.role === 'site', 'repo2 role');
});

step('listProjects returns the project + both repos', () => {
  const projects = listProjects();
  assert(projects.length === 1, `expected 1 project, got ${projects.length}`);
  const found = projects[0];
  assert(found.repos.length === 2, `expected 2 repos, got ${found.repos.length}`);
});

step('listProjectsByRepoId finds membership', () => {
  const memberships = listProjectsByRepoId('repo-cortex-ide');
  assert(memberships.length === 1, 'expected 1 membership');
  assert(memberships[0].id === project.id, 'membership points to project');
  assert(memberships[0].repos.length === 2, 'membership carries repos');
});

step('addRepoToProject is idempotent + refreshes role', () => {
  const link = addRepoToProject(project.id, 'repo-cortex-ide', 'backend', 'manual');
  assert(link.role === 'backend', 'role refreshed to backend');
  const all = listProjects();
  assert(all[0].repos.length === 2, 'still 2 repos after re-add');
});

step('setRepoRole updates role on existing link', () => {
  const link = setRepoRole(project.id, 'repo-cortex-ide', 'fullstack');
  assert(link, 'setRepoRole returned null');
  assert(link.role === 'fullstack', 'role updated');
});

step('updateProject patches name + description', () => {
  const updated = updateProject(project.id, {
    name: 'O8 Product Suite',
    description: null,
  });
  assert(updated, 'updateProject null');
  assert(updated.name === 'O8 Product Suite', 'name updated');
  assert(updated.description === null, 'description cleared');
});

step('removeRepoFromProject drops the link', () => {
  const removed = removeRepoFromProject(project.id, 'repo-cortex-ide');
  assert(removed, 'remove returned false');
  const fresh = listProjects();
  assert(fresh[0].repos.length === 1, 'expected 1 repo after remove');
  assert(fresh[0].repos[0].repoId === 'repo-o8-site', 'remaining repo is the site');
});

step('removeRepoFromProject is idempotent (returns false on missing)', () => {
  const removed = removeRepoFromProject(project.id, 'repo-cortex-ide');
  assert(!removed, 'remove returned true on missing link');
});

step('recordDismissedSuggestion + isDismissed round-trip', () => {
  recordDismissedSuggestion('fingerprint-abc', 'not-related');
  assert(isDismissed('fingerprint-abc'), 'fingerprint should be dismissed');
  assert(!isDismissed('fingerprint-xyz'), 'unknown fingerprint should not be dismissed');
});

step('deleteProject cascades into project_repos', () => {
  const deleted = deleteProject(project.id);
  assert(deleted, 'delete returned false');
  assert(getProject(project.id) === null, 'project still exists after delete');
  assert(listProjects().length === 0, 'projects list is empty after delete');
});

step('createProject auto-suffixes slug on collision', () => {
  const first = createProject({ name: 'Alpha' });
  const second = createProject({ name: 'Alpha' });
  assert(first.slug === 'alpha', 'first slug is alpha');
  assert(second.slug.startsWith('alpha-'), `second slug should suffix, got ${second.slug}`);
  deleteProject(first.id);
  deleteProject(second.id);
});

console.log('\n✓ All smoke tests passed.');
