//! Symon Tier-3 tools — read-only local git + GitHub (via the `gh` CLI).
//!
//! Lets Symon answer "any open PRs on o8?", "what's the git status?",
//! "recent commits?" by voice. ReadOnly except `gh_issue_create` (voice
//! capture to the tracker — Reversible, carded). The repo name resolves to an absolute path via
//! `super::o8_bridge::resolve_repo_path`; commands run with that path as cwd so
//! `git`/`gh` auto-detect the repo + its remote.

use super::o8_bridge::resolve_repo_path;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const COMMIT_DIFF_OUTPUT_CAP_BYTES: usize = 16 * 1024;
const COMMIT_DIFF_BODY_CAP_BYTES: usize = 15 * 1024;
const COMMIT_METADATA_CAP_BYTES: usize = 4 * 1024;

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

fn run_bytes(cmd: &str, args: &[&str], cwd: &str) -> Result<Vec<u8>, String> {
    let out = Command::new(bin(cmd))
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("{cmd} exec failed: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("{cmd} failed")
        } else {
            err
        })
    }
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn validate_sha(sha: &str) -> Result<&str, String> {
    let sha = sha.trim();
    if !(4..=64).contains(&sha.len()) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("repo_commit_diff requires a 4-64 character hexadecimal commit sha".into());
    }
    Ok(sha)
}

fn validate_file(file: &str) -> Result<&str, String> {
    let file = file.trim();
    if file.is_empty() || file.len() > 1_024 {
        return Err("repo_commit_diff file must be a non-empty relative path".into());
    }
    let path = Path::new(file);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("repo_commit_diff file must stay within the tracked repository".into());
    }
    Ok(file)
}

fn strict_tracked_repo_path(requested: &str, tracked: &[String]) -> Result<String, String> {
    let requested = requested.trim();
    let requested_path = PathBuf::from(requested);
    if requested.is_empty()
        || !requested_path.is_absolute()
        || requested_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("repo_commit_diff requires an exact tracked repository path".into());
    }
    let requested_canonical = requested_path
        .canonicalize()
        .map_err(|_| format!("repo_commit_diff repoPath does not resolve: '{requested}'"))?;
    for tracked_path in tracked {
        let tracked_path = PathBuf::from(tracked_path);
        if requested_path != tracked_path {
            continue;
        }
        let tracked_canonical = tracked_path
            .canonicalize()
            .map_err(|_| "The tracked repository path no longer resolves".to_string())?;
        if requested_canonical == tracked_canonical && requested_canonical.is_dir() {
            return Ok(requested_canonical.to_string_lossy().to_string());
        }
    }
    Err(format!(
        "repo_commit_diff refused untracked repository path '{requested}'"
    ))
}

async fn tracked_repo_paths() -> Result<Vec<String>, String> {
    let response = crate::agent::o8_http::get_json("/api/panel/repos").await?;
    Ok(response
        .get("repos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|repo| repo.get("localPath").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

fn commit_files(repo: &str, sha: &str) -> Result<Vec<String>, String> {
    let bytes = run_bytes(
        "git",
        &[
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            sha,
            "--",
        ],
        repo,
    )?;
    Ok(bytes
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(|name| String::from_utf8_lossy(name).to_string())
        .collect())
}

fn bounded_metadata(metadata: &str) -> String {
    if metadata.len() <= COMMIT_METADATA_CAP_BYTES {
        return metadata.to_string();
    }
    format!(
        "{}\n… commit metadata truncated\n",
        utf8_prefix(metadata, COMMIT_METADATA_CAP_BYTES)
    )
}

fn bounded_single_file_patch(patch: &str, file: &str) -> (String, bool) {
    if patch.len() <= COMMIT_DIFF_BODY_CAP_BYTES {
        return (patch.to_string(), false);
    }
    let display = utf8_prefix(file, 160);
    let marker = format!("\n… patch for {display} truncated\n");
    let available = COMMIT_DIFF_BODY_CAP_BYTES.saturating_sub(marker.len());
    (format!("{}{}", utf8_prefix(patch, available), marker), true)
}

fn whole_commit_patch(repo: &str, sha: &str) -> Result<(String, bool, usize), String> {
    let metadata = run(
        "git",
        &[
            "show",
            "--no-color",
            "--no-ext-diff",
            "--format=fuller",
            "--no-patch",
            sha,
        ],
        repo,
    )?;
    let files = commit_files(repo, sha)?;
    let mut output = bounded_metadata(&metadata);
    if !output.is_empty() {
        output.push('\n');
    }
    for (index, file) in files.iter().enumerate() {
        let patch = run(
            "git",
            &[
                "show",
                "--no-color",
                "--no-ext-diff",
                "--format=",
                sha,
                "--",
                file,
            ],
            repo,
        )?;
        let separator = if output.ends_with('\n') { "" } else { "\n" };
        if output.len() + separator.len() + patch.len() <= COMMIT_DIFF_BODY_CAP_BYTES {
            output.push_str(separator);
            output.push_str(&patch);
            continue;
        }

        output.push_str(separator);
        let display = utf8_prefix(file, 160);
        let truncation = format!("\n… patch for {display} truncated\n");
        let omitted = files.len().saturating_sub(index + 1);
        let omitted_marker = if omitted > 0 {
            format!("… {omitted} more files omitted\n")
        } else {
            String::new()
        };
        let available = COMMIT_DIFF_BODY_CAP_BYTES.saturating_sub(output.len());
        output.push_str(utf8_prefix(&patch, available));
        output.push_str(&truncation);
        output.push_str(&omitted_marker);
        debug_assert!(output.len() < COMMIT_DIFF_OUTPUT_CAP_BYTES);
        return Ok((output, true, omitted));
    }
    Ok((output, false, 0))
}

fn repo_commit_diff_in_tracked_set(args: Value, tracked: &[String]) -> Result<Value, String> {
    let repo_path = args
        .get("repoPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "repo_commit_diff requires repoPath".to_string())?;
    let repo = strict_tracked_repo_path(repo_path, tracked)?;
    let sha = validate_sha(
        args.get("sha")
            .and_then(Value::as_str)
            .ok_or_else(|| "repo_commit_diff requires sha".to_string())?,
    )?;
    run(
        "git",
        &["rev-parse", "--verify", &format!("{sha}^{{commit}}")],
        &repo,
    )
    .map_err(|error| format!("repo_commit_diff could not resolve commit {sha}: {error}"))?;

    if let Some(file) = args.get("file").and_then(Value::as_str) {
        let file = validate_file(file)?;
        let patch = run(
            "git",
            &[
                "show",
                "--no-color",
                "--no-ext-diff",
                "--format=fuller",
                sha,
                "--",
                file,
            ],
            &repo,
        )?;
        if !patch.contains("diff --git ") {
            return Err(format!(
                "Commit {sha} does not contain a patch for '{file}'"
            ));
        }
        let (patch, truncated) = bounded_single_file_patch(&patch, file);
        debug_assert!(patch.len() < COMMIT_DIFF_OUTPUT_CAP_BYTES);
        return Ok(json!({ "patch": patch, "truncated": truncated, "omittedFiles": 0 }));
    }

    let (patch, truncated, omitted_files) = whole_commit_patch(&repo, sha)?;
    debug_assert!(patch.len() < COMMIT_DIFF_OUTPUT_CAP_BYTES);
    Ok(json!({ "patch": patch, "truncated": truncated, "omittedFiles": omitted_files }))
}

pub async fn repo_commit_diff(args: Value) -> Result<Value, String> {
    let tracked = tracked_repo_paths().await?;
    repo_commit_diff_in_tracked_set(args, &tracked)
}

/// Resolve the `repo` arg (folder name or absolute path) to a repo dir.
async fn repo_arg(args: &Value) -> Result<String, String> {
    let repo = args.get("repo").and_then(|v| v.as_str()).unwrap_or("").trim();
    if repo.is_empty() {
        return Err("which repo? (e.g. 'o8')".into());
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

/// `gh_issue_create` — voice capture straight to the repo tracker ("file an
/// issue: the dock flickers on wake"). The ONE write in this module —
/// Reversible in `safety`, so the confirm card speaks the title + repo before
/// anything lands on GitHub.
pub async fn issue_create(args: Value) -> Result<Value, String> {
    let path = repo_arg(&args).await?;
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
    if title.is_empty() {
        return Err("gh_issue_create needs a 'title'".into());
    }
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Filed by voice via Symon.".to_string());

    let out = run("gh", &["issue", "create", "--title", title, "--body", &body], &path)?;
    // gh prints the new issue URL on success.
    let url = out
        .lines()
        .rev()
        .find(|l| l.contains("github.com"))
        .unwrap_or("")
        .trim();
    Ok(json!({ "created": true, "title": title, "url": url }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestRepo {
        root: PathBuf,
        sha: String,
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run git fixture command");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn fixture_repo() -> TestRepo {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "o8-repo-commit-diff-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "--quiet"]);
        for index in 0..8 {
            fs::write(root.join(format!("{index:02}-large.txt")), "before\n").unwrap();
        }
        fs::write(root.join("single.txt"), "before\n").unwrap();
        git(&root, &["add", "."]);
        git(
            &root,
            &[
                "-c",
                "user.name=o8 tests",
                "-c",
                "user.email=o8-tests@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "baseline",
            ],
        );
        for index in 0..8 {
            let content = (0..500)
                .map(|line| {
                    format!(
                        "file {index:02} changed line {line:04} {}\n",
                        "x".repeat(72)
                    )
                })
                .collect::<String>();
            fs::write(root.join(format!("{index:02}-large.txt")), content).unwrap();
        }
        fs::write(root.join("single.txt"), "after: one focused patch\n").unwrap();
        git(&root, &["add", "."]);
        git(
            &root,
            &[
                "-c",
                "user.name=o8 tests",
                "-c",
                "user.email=o8-tests@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "large synthetic change",
            ],
        );
        let sha = git(&root, &["rev-parse", "HEAD"]);
        TestRepo { root, sha }
    }

    fn patch(result: &Value) -> &str {
        result
            .get("patch")
            .and_then(Value::as_str)
            .expect("patch string")
    }

    #[test]
    fn commit_diff_caps_multi_file_output_with_both_truncation_markers() {
        let repo = fixture_repo();
        let tracked = vec![repo.root.to_string_lossy().to_string()];
        let result = repo_commit_diff_in_tracked_set(
            json!({ "repoPath": tracked[0], "sha": repo.sha }),
            &tracked,
        )
        .unwrap();
        let output = patch(&result);
        assert!(output.len() < COMMIT_DIFF_OUTPUT_CAP_BYTES);
        assert!(output.contains("… patch for 00-large.txt truncated"));
        assert!(output.contains("more files omitted"));
        assert!(result["omittedFiles"].as_u64().unwrap() > 0);
    }

    #[test]
    fn commit_diff_filters_to_one_file_patch() {
        let repo = fixture_repo();
        let tracked = vec![repo.root.to_string_lossy().to_string()];
        let result = repo_commit_diff_in_tracked_set(
            json!({ "repoPath": tracked[0], "sha": repo.sha, "file": "single.txt" }),
            &tracked,
        )
        .unwrap();
        let output = patch(&result);
        assert!(output.contains("diff --git a/single.txt b/single.txt"));
        assert!(output.contains("after: one focused patch"));
        assert!(!output.contains("00-large.txt"));
    }

    #[test]
    fn commit_diff_rejects_paths_outside_the_exact_tracked_set() {
        let repo = fixture_repo();
        let outside = repo.root.with_extension("outside");
        fs::create_dir_all(&outside).unwrap();
        let tracked = vec![repo.root.to_string_lossy().to_string()];
        let error = repo_commit_diff_in_tracked_set(
            json!({ "repoPath": outside, "sha": repo.sha }),
            &tracked,
        )
        .unwrap_err();
        let _ = fs::remove_dir_all(&outside);
        assert!(error.contains("untracked repository path"));

        fs::create_dir_all(repo.root.join("nested")).unwrap();
        let traversal = format!("{}/nested/..", repo.root.to_string_lossy());
        let error = repo_commit_diff_in_tracked_set(
            json!({ "repoPath": traversal, "sha": repo.sha }),
            &tracked,
        )
        .unwrap_err();
        assert!(error.contains("exact tracked repository path"));
    }

    #[test]
    fn commit_diff_rejects_non_hexadecimal_sha_input() {
        let repo = fixture_repo();
        let tracked = vec![repo.root.to_string_lossy().to_string()];
        let error = repo_commit_diff_in_tracked_set(
            json!({ "repoPath": tracked[0], "sha": "HEAD; rm -rf nope" }),
            &tracked,
        )
        .unwrap_err();
        assert!(error.contains("hexadecimal commit sha"));
    }

    #[test]
    fn commit_diff_is_enabled_and_never_requires_confirmation() {
        let enabled = super::super::enabled_tools();
        assert!(enabled
            .iter()
            .any(|tool| { tool.get("name").and_then(Value::as_str) == Some("repo_commit_diff") }));
        let class = crate::agent::safety::tool_safety_class("repo_commit_diff");
        assert_eq!(class, crate::agent::safety::SafetyClass::ReadOnly);
        assert!(!crate::agent::safety::requires_confirmation(class, false));
    }
}
