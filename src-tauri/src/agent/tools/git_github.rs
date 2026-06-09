//! Symon Tier-3 tools — read-only local git + GitHub (via the `gh` CLI).
//!
//! Lets Symon answer "any open PRs on cortex-ide?", "what's the git status?",
//! "recent commits?" by voice. All ReadOnly: only read subcommands run
//! (status/log, `gh ... list`). The repo name resolves to an absolute path via
//! `super::o8_bridge::resolve_repo_path`; commands run with that path as cwd so
//! `git`/`gh` auto-detect the repo + its remote.

use super::o8_bridge::resolve_repo_path;
use serde_json::{json, Value};
use std::process::Command;

/// Resolve a CLI binary to an absolute path. The app augments PATH from the
/// login shell at boot, but fall back to common locations so a Finder-launched
/// app with a minimal PATH still finds Homebrew/system binaries.
fn bin(name: &str) -> String {
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = format!("{dir}/{name}");
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    name.to_string()
}

/// Run a read-only command in `cwd`, returning trimmed stdout. Errors fold in
/// stderr so the model can speak a useful reason.
fn run(cmd: &str, args: &[&str], cwd: &str) -> Result<String, String> {
    let out = Command::new(bin(cmd))
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("{cmd} exec failed: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { format!("{cmd} failed") } else { err })
    }
}

/// Resolve the `repo` arg (folder name or absolute path) to a repo dir.
async fn repo_arg(args: &Value) -> Result<String, String> {
    let repo = args.get("repo").and_then(|v| v.as_str()).unwrap_or("").trim();
    if repo.is_empty() {
        return Err("which repo? (e.g. 'cortex-ide')".into());
    }
    resolve_repo_path(repo).await
}

pub async fn git_status(args: Value) -> Result<Value, String> {
    let path = repo_arg(&args).await?;
    let out = run("git", &["status", "--short", "--branch"], &path)?;
    Ok(json!({ "status": out }))
}

pub async fn git_log(args: Value) -> Result<Value, String> {
    let path = repo_arg(&args).await?;
    let count = args.get("count").and_then(|v| v.as_u64()).unwrap_or(10).clamp(1, 30);
    let n = format!("-n{count}");
    let out = run("git", &["log", "--oneline", &n], &path)?;
    Ok(json!({ "commits": out }))
}

pub async fn pr_list(args: Value) -> Result<Value, String> {
    let path = repo_arg(&args).await?;
    let out = run(
        "gh",
        &["pr", "list", "--limit", "15", "--json", "number,title,state,author"],
        &path,
    )?;
    let prs: Value = serde_json::from_str(&out).unwrap_or_else(|_| json!([]));
    let count = prs.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(json!({ "count": count, "prs": prs }))
}

pub async fn issue_list(args: Value) -> Result<Value, String> {
    let path = repo_arg(&args).await?;
    let out = run(
        "gh",
        &["issue", "list", "--limit", "15", "--json", "number,title,state"],
        &path,
    )?;
    let issues: Value = serde_json::from_str(&out).unwrap_or_else(|_| json!([]));
    let count = issues.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(json!({ "count": count, "issues": issues }))
}
