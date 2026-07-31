//! Cross-repository GitHub maintainer triage via bounded REST pages.

use super::git_github::tracked_repo_paths;
use super::git_github_maintainer::{
    age_label, author_login, bounded_field, bounded_text, gh_api_pages, github_observed, repo_slug,
    GITHUB_TITLE_LIMIT, GITHUB_TRIAGE_BODY_CAP_BYTES, GITHUB_URL_LIMIT,
};
use super::o8_bridge::resolve_repo_path;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const GITHUB_TRIAGE_ITEM_LIMIT: usize = 30;

#[derive(Clone, Debug)]
struct TriageItem {
    repo: String,
    occurred_at: String,
    value: Value,
}

#[derive(Clone, Copy, Debug, Default)]
struct TriageCounts {
    issues: usize,
    prs: usize,
    comments: usize,
}

#[derive(Debug)]
struct TriageRepo {
    repo: String,
    items: Vec<TriageItem>,
    counts: TriageCounts,
    source_truncated: bool,
    content_truncated: bool,
}

fn at_or_after(value: &Value, key: &str, since: DateTime<Utc>) -> bool {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .is_some_and(|timestamp| timestamp.with_timezone(&Utc) >= since)
}

fn url_number(value: &Value, key: &str) -> Option<u64> {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(|url| url.rsplit('/').next())
        .and_then(|number| number.parse().ok())
}

fn triage_repo(
    path: &str,
    slug: &str,
    since: DateTime<Utc>,
    since_rfc3339: &str,
) -> Result<TriageRepo, String> {
    // REST is deliberate: these endpoints honor an exact `since` timestamp,
    // while `gh search` depends on index freshness and has no complete comment
    // stream for a repository.
    let issues_endpoint = format!("repos/{slug}/issues?state=all&since={since_rfc3339}");
    let comments_endpoint = format!("repos/{slug}/issues/comments?since={since_rfc3339}");
    let review_comments_endpoint = format!("repos/{slug}/pulls/comments?since={since_rfc3339}");
    let (updated_issues, issues_truncated) = gh_api_pages(path, &issues_endpoint)?;
    let (issue_comments, issue_comments_truncated) = gh_api_pages(path, &comments_endpoint)?;
    let (review_comments, review_comments_truncated) =
        gh_api_pages(path, &review_comments_endpoint)?;
    let source_truncated =
        issues_truncated || issue_comments_truncated || review_comments_truncated;
    let mut content_truncated = false;
    let mut titles: HashMap<u64, (String, bool)> = HashMap::new();
    for item in &updated_issues {
        let Some(number) = item.get("number").and_then(Value::as_u64) else {
            continue;
        };
        let (title, title_truncated) = bounded_field(
            item.get("title").and_then(Value::as_str),
            GITHUB_TITLE_LIMIT,
        );
        content_truncated |= title_truncated;
        titles.insert(number, (title, item.get("pull_request").is_some()));
    }

    let mut items = Vec::new();
    let mut counts = TriageCounts::default();
    for item in &updated_issues {
        if !at_or_after(item, "created_at", since) {
            continue;
        }
        let number = item.get("number").and_then(Value::as_u64).unwrap_or(0);
        let is_pr = item.get("pull_request").is_some();
        let (title, title_truncated) = bounded_field(
            item.get("title").and_then(Value::as_str),
            GITHUB_TITLE_LIMIT,
        );
        let (author, author_truncated) = author_login(item);
        let (url, url_truncated) = bounded_field(
            item.get("html_url").and_then(Value::as_str),
            GITHUB_URL_LIMIT,
        );
        content_truncated |= title_truncated || author_truncated || url_truncated;
        let created_at = item
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if is_pr {
            counts.prs += 1;
        } else {
            counts.issues += 1;
        }
        items.push(TriageItem {
            repo: slug.to_string(),
            occurred_at: created_at.clone(),
            value: json!({
                "kind": if is_pr { "pr" } else { "issue" },
                "number": number,
                "title": title,
                "author": author,
                "createdAt": created_at,
                "age": age_label(item.get("created_at").and_then(Value::as_str).unwrap_or("")),
                "url": url,
            }),
        });
    }

    for comment in issue_comments
        .iter()
        .filter(|item| at_or_after(item, "created_at", since))
    {
        let number = url_number(comment, "issue_url").unwrap_or(0);
        let html_url = comment
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_pr = titles
            .get(&number)
            .map(|(_, is_pr)| *is_pr)
            .unwrap_or_else(|| html_url.contains("/pull/"));
        let (title, _) = titles.get(&number).cloned().unwrap_or_default();
        let (author, author_truncated) = author_login(comment);
        let (body, body_truncated) = bounded_field(
            comment.get("body").and_then(Value::as_str),
            GITHUB_TRIAGE_BODY_CAP_BYTES,
        );
        let (url, url_truncated) = bounded_text(html_url, GITHUB_URL_LIMIT);
        content_truncated |= author_truncated || body_truncated || url_truncated;
        let created_at = comment
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        counts.comments += 1;
        items.push(TriageItem {
            repo: slug.to_string(),
            occurred_at: created_at.clone(),
            value: json!({
                "kind": if is_pr { "pr_comment" } else { "issue_comment" },
                "number": number,
                "title": title,
                "author": author,
                "createdAt": created_at,
                "age": age_label(comment.get("created_at").and_then(Value::as_str).unwrap_or("")),
                "body": body,
                "bodyTruncated": body_truncated,
                "url": url,
            }),
        });
    }

    for comment in review_comments
        .iter()
        .filter(|item| at_or_after(item, "created_at", since))
    {
        let number = url_number(comment, "pull_request_url").unwrap_or(0);
        let (title, _) = titles.get(&number).cloned().unwrap_or_default();
        let (author, author_truncated) = author_login(comment);
        let (body, body_truncated) = bounded_field(
            comment.get("body").and_then(Value::as_str),
            GITHUB_TRIAGE_BODY_CAP_BYTES,
        );
        let (url, url_truncated) = bounded_field(
            comment.get("html_url").and_then(Value::as_str),
            GITHUB_URL_LIMIT,
        );
        content_truncated |= author_truncated || body_truncated || url_truncated;
        let created_at = comment
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        counts.comments += 1;
        items.push(TriageItem {
            repo: slug.to_string(),
            occurred_at: created_at.clone(),
            value: json!({
                "kind": "review_comment",
                "number": number,
                "title": title,
                "author": author,
                "createdAt": created_at,
                "age": age_label(comment.get("created_at").and_then(Value::as_str).unwrap_or("")),
                "body": body,
                "bodyTruncated": body_truncated,
                "url": url,
            }),
        });
    }
    items.sort_by(|left, right| right.occurred_at.cmp(&left.occurred_at));
    Ok(TriageRepo {
        repo: slug.to_string(),
        items,
        counts,
        source_truncated,
        content_truncated,
    })
}

pub async fn triage(args: Value) -> Result<Value, String> {
    let since_hours = match args.get("since_hours") {
        None | Some(Value::Null) => 24,
        Some(value) => value
            .as_u64()
            .filter(|hours| (1..=720).contains(hours))
            .ok_or_else(|| "gh_triage since_hours must be an integer from 1 to 720".to_string())?,
    };
    let since = Utc::now() - Duration::hours(since_hours as i64);
    let since_rfc3339 = since.to_rfc3339_opts(SecondsFormat::Secs, true);
    let requested_repo = args
        .get("repo")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|repo| !repo.is_empty());
    let paths = if let Some(repo) = requested_repo {
        vec![resolve_repo_path(repo).await?]
    } else {
        tracked_repo_paths().await?
    };
    if paths.is_empty() {
        return Err("No tracked repositories are available for GitHub triage".to_string());
    }

    let mut repos = Vec::new();
    let mut seen = HashSet::new();
    let mut skipped_repo_count = 0usize;
    for path in paths {
        let result = repo_slug(&path).and_then(|slug| {
            if !seen.insert(slug.clone()) {
                return Ok(None);
            }
            triage_repo(&path, &slug, since, &since_rfc3339).map(Some)
        });
        match result {
            Ok(Some(repo)) => repos.push(repo),
            Ok(None) => {}
            Err(error) if requested_repo.is_some() => return Err(error),
            Err(_) => skipped_repo_count += 1,
        }
    }
    if repos.is_empty() {
        return Err(
            "None of the tracked repositories resolved to an accessible GitHub remote".to_string(),
        );
    }
    repos.sort_by(|left, right| {
        let left_latest = left
            .items
            .first()
            .map(|item| item.occurred_at.as_str())
            .unwrap_or("");
        let right_latest = right
            .items
            .first()
            .map(|item| item.occurred_at.as_str())
            .unwrap_or("");
        right_latest.cmp(left_latest)
    });

    let counts = repos
        .iter()
        .fold(TriageCounts::default(), |mut total, repo| {
            total.issues += repo.counts.issues;
            total.prs += repo.counts.prs;
            total.comments += repo.counts.comments;
            total
        });
    let mut all_items = repos
        .iter()
        .flat_map(|repo| repo.items.iter().cloned())
        .collect::<Vec<_>>();
    all_items.sort_by(|left, right| right.occurred_at.cmp(&left.occurred_at));
    let total_items = all_items.len();
    all_items.truncate(GITHUB_TRIAGE_ITEM_LIMIT);
    let source_truncated = repos.iter().any(|repo| repo.source_truncated);
    let content_truncated = repos.iter().any(|repo| repo.content_truncated);
    let truncated = source_truncated || content_truncated || total_items > all_items.len();
    let groups = repos
        .iter()
        .map(|repo| {
            let items = all_items
                .iter()
                .filter(|item| item.repo == repo.repo)
                .map(|item| item.value.clone())
                .collect::<Vec<_>>();
            json!({
                "repo": repo.repo,
                "counts": {
                    "newIssues": repo.counts.issues,
                    "newPrs": repo.counts.prs,
                    "newComments": repo.counts.comments,
                    "total": repo.counts.issues + repo.counts.prs + repo.counts.comments,
                },
                "itemsReturned": items.len(),
                "items": items,
            })
        })
        .collect::<Vec<_>>();
    Ok(github_observed(
        "github_rest_api_via_gh_cli",
        json!({
            "mechanism": "gh api REST issue and comment endpoints with exact since timestamps",
            "sinceHours": since_hours,
            "since": since_rfc3339,
            "counts": {
                "newIssues": counts.issues,
                "newPrs": counts.prs,
                "newComments": counts.comments,
                "total": total_items,
                "sourceCountTruncated": source_truncated,
            },
            "itemsReturned": all_items.len(),
            "groups": groups,
            "skippedRepoCount": skipped_repo_count,
        }),
        truncated,
    ))
}
