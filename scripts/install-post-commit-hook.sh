#!/bin/sh
#
# Engineering Brain — install post-commit hook (#963).
#
# Writes .git/hooks/post-commit in the target repo (defaults to the repo where
# this script lives). The hook runs entirely in the background so it never
# blocks the commit.
#
# Usage:
#   bash scripts/install-post-commit-hook.sh              # install in this repo
#   bash scripts/install-post-commit-hook.sh /path/repo   # install in another repo
#   bash scripts/install-post-commit-hook.sh remove       # uninstall from this repo
#   bash scripts/install-post-commit-hook.sh status       # show installed hook
#
# Idempotent: re-running replaces the hook with the current version.
#
# The hook is POSIX sh — no bash-isms. It:
#   1. Exits silently if `claude` is not on PATH (founder-only CLI constraint).
#   2. Gathers the commit SHA + message + changed files.
#   3. Launches `npx tsx scripts/distill-commit.ts` in background (detached).
#   4. Exits 0 immediately so the commit is never blocked.
#
# The distiller itself enforces SHA-level idempotency in SQLite so duplicate
# runs (e.g. amend, rebase) are no-ops.

set -e

# ── Resolve paths ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# First argument may override the target repo root OR be a subcommand.
TARGET_REPO="${REPO_ROOT}"
SUBCOMMAND="install"

if [ -n "${1:-}" ]; then
  if [ -d "${1}/.git" ]; then
    TARGET_REPO="$1"
    SUBCOMMAND="${2:-install}"
  else
    SUBCOMMAND="$1"
  fi
fi

GIT_HOOKS_DIR="${TARGET_REPO}/.git/hooks"
HOOK_PATH="${GIT_HOOKS_DIR}/post-commit"
DISTILLER_PATH="${REPO_ROOT}/scripts/distill-commit.ts"

# ── Helpers ──────────────────────────────────────────────────────────────────

log() { printf '[install-post-commit-hook] %s\n' "$*"; }

# Resolve npx with a non-interactive shell probe. launchd / hook envs often
# don't have the user's PATH, so we anchor to the same node bin directory.
resolve_npx() {
  # Try non-interactive shell first (no banner, clean stdout).
  _found="$(/bin/sh -c 'command -v npx' 2>/dev/null)"
  if [ -z "${_found}" ]; then
    _found="$(command -v npx 2>/dev/null)"
  fi
  # Strip leading/trailing whitespace.
  printf '%s' "${_found}" | tr -d '[:space:]'
}

# ── install ──────────────────────────────────────────────────────────────────

install_hook() {
  if [ ! -d "${GIT_HOOKS_DIR}" ]; then
    log "ERROR: .git/hooks not found at ${GIT_HOOKS_DIR}" >&2
    exit 1
  fi
  if [ ! -f "${DISTILLER_PATH}" ]; then
    log "ERROR: distiller not found at ${DISTILLER_PATH}" >&2
    exit 1
  fi

  NPX_BIN="$(resolve_npx)"
  if [ -z "${NPX_BIN}" ] || [ ! -x "${NPX_BIN}" ]; then
    log "WARNING: could not resolve npx — hook will fall back to PATH resolution at commit time"
    NPX_BIN="npx"
  fi

  # Derive a PATH that covers the node bin directory alongside standard dirs.
  NODE_BIN_DIR="$(dirname "${NPX_BIN}")"
  HOOK_PATH_ENV="${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

  # Write the hook. Single-quote the heredoc delimiter so no variable
  # expansion happens inside the hook body — the hook must be literal sh.
  cat > "${HOOK_PATH}" <<ENDOFHOOK
#!/bin/sh
# Engineering Brain post-commit hook (#963) — auto-generated, do not edit.
# Re-generate with: bash ${REPO_ROOT}/scripts/install-post-commit-hook.sh

# Never block the commit. Every path that could fail exits 0 immediately.

# Augment PATH so node/npx are findable in non-login shells (Finder, IDEs).
export PATH="${HOOK_PATH_ENV}:\$PATH"

# Skip silently if claude CLI is unavailable (free-tier, CI, no Max sub).
if ! command -v claude > /dev/null 2>&1; then
  exit 0
fi

# Gather commit information.
COMMIT_SHA="\$(git rev-parse HEAD 2>/dev/null)"
if [ -z "\${COMMIT_SHA}" ]; then
  exit 0
fi

COMMIT_MSG="\$(git log -1 --format='%B' "\${COMMIT_SHA}" 2>/dev/null)"
if [ -z "\${COMMIT_MSG}" ]; then
  exit 0
fi

# Changed files in this commit (paths only, one per line).
CHANGED_FILES="\$(git diff-tree --no-commit-id -r --name-only "\${COMMIT_SHA}" 2>/dev/null)"

# Build argument list. Message and files are passed as quoted args.
# The distiller handles its own quoting — we just need to get them through.
# Run detached (&) + redirect output so the hook returns immediately.
(
  # Use the same repo root this hook came from so tsx can resolve @/ paths.
  cd "${REPO_ROOT}" 2>/dev/null || exit 0

  # Build the file list as separate arguments (safe for paths with spaces).
  FILE_ARGS=""
  while IFS= read -r f; do
    FILE_ARGS="\${FILE_ARGS} \"\${f}\""
  done <<EOF2
\${CHANGED_FILES}
EOF2

  eval "${NPX_BIN} tsx ${DISTILLER_PATH} \\
    '\${COMMIT_SHA}' \\
    '\${COMMIT_MSG}' \\
    \${FILE_ARGS}" \
    >> "\${HOME}/.o8/logs/commit-distill.log" 2>&1
) &
disown \$! 2>/dev/null || true

exit 0
ENDOFHOOK

  chmod +x "${HOOK_PATH}"

  log "installed: ${HOOK_PATH}"
  log "distiller: ${DISTILLER_PATH}"
  log "npx:       ${NPX_BIN}"
  log ""
  log "The hook runs distill-commit.ts in the background after every commit."
  log "Logs: \$HOME/.o8/logs/commit-distill.log"
  log ""
  log "Commands:"
  log "  bash ${REPO_ROOT}/scripts/install-post-commit-hook.sh status   # show hook"
  log "  bash ${REPO_ROOT}/scripts/install-post-commit-hook.sh remove   # uninstall"
}

# ── remove ───────────────────────────────────────────────────────────────────

remove_hook() {
  if [ ! -f "${HOOK_PATH}" ]; then
    log "hook not installed at ${HOOK_PATH} (nothing to do)"
    return
  fi
  rm -f "${HOOK_PATH}"
  log "removed: ${HOOK_PATH}"
}

# ── status ───────────────────────────────────────────────────────────────────

status_hook() {
  if [ ! -f "${HOOK_PATH}" ]; then
    log "not installed (${HOOK_PATH} missing)"
    return
  fi
  log "installed: ${HOOK_PATH}"
  printf '\n--- hook contents ---\n'
  cat "${HOOK_PATH}"
  printf '--- end ---\n'
}

# ── Dispatch ──────────────────────────────────────────────────────────────────

case "${SUBCOMMAND}" in
  install)
    install_hook
    ;;
  remove)
    remove_hook
    ;;
  status)
    status_hook
    ;;
  *)
    printf 'usage: %s [install|remove|status] [repo-path]\n' "$0" >&2
    exit 1
    ;;
esac
