use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Default)]
pub struct LaneSnapshot {
    ids: HashSet<String>,
}

impl LaneSnapshot {
    pub fn from_response(response: &Value) -> Self {
        let ids = response
            .get("lanes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|lane| lane.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        Self { ids }
    }

    pub fn confirmed_spawned_lane_ids(
        &self,
        response: &Value,
        repo: Option<&str>,
        task: &str,
    ) -> Vec<String> {
        let task_prefix = normalized_task_prefix(task);
        response
            .get("lanes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|lane| {
                let id = lane.get("id").and_then(Value::as_str)?;
                if self.ids.contains(id) {
                    return None;
                }
                let label = lane.get("label").and_then(Value::as_str).unwrap_or("");
                if task_prefix.is_empty() || !label.starts_with(&task_prefix) {
                    return None;
                }
                let lane_repo = lane.get("repoPath").and_then(Value::as_str).unwrap_or("");
                if !repo_matches(repo, lane_repo) {
                    return None;
                }
                Some(id.to_string())
            })
            .collect()
    }
}

fn normalized_task_prefix(task: &str) -> String {
    task.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(48)
        .collect()
}

fn repo_matches(requested: Option<&str>, lane_repo: &str) -> bool {
    let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    lane_repo == requested
        || lane_repo
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .is_some_and(|name| name == requested.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::LaneSnapshot;
    use serde_json::json;

    #[test]
    fn confirms_only_a_new_lane_matching_the_spawn_task_and_repo() {
        let before = LaneSnapshot::from_response(&json!({
            "lanes": [{ "id": "lane-old", "repoPath": "/Users/operator/o8", "label": "Repair auth" }]
        }));
        let after = json!({
            "lanes": [
                { "id": "lane-old", "repoPath": "/Users/operator/o8", "label": "Repair auth" },
                { "id": "lane-new", "repoPath": "/Users/operator/o8", "label": "Repair auth (1/2)" },
                { "id": "lane-other", "repoPath": "/Users/operator/other", "label": "Repair auth (2/2)" }
            ]
        });

        assert_eq!(
            before.confirmed_spawned_lane_ids(
                &after,
                Some("/Users/operator/o8"),
                "Repair   auth"
            ),
            vec!["lane-new"]
        );
    }

    #[test]
    fn does_not_treat_an_existing_matching_lane_as_timeout_recovery() {
        let response = json!({
            "lanes": [{ "id": "lane-old", "repoPath": "/Users/operator/o8", "label": "Repair auth" }]
        });
        let before = LaneSnapshot::from_response(&response);

        assert!(before
            .confirmed_spawned_lane_ids(&response, Some("o8"), "Repair auth")
            .is_empty());
    }
}
