use super::*;

const GROUPS: [&str; 5] = ["blocked", "review", "running", "ready", "done"];
fn group(packet: &Value, lane: &Value) -> &'static str {
    let ps = packet["status"].as_str().unwrap_or("");
    let ls = lane["status"].as_str().unwrap_or("");
    if packet["releaseState"] == "released"
        || matches!(ps, "released" | "archived")
        || matches!(ls, "completed" | "archived")
    {
        "done"
    } else if ps == "awaiting_review" || ls == "reviewing" {
        "review"
    } else if matches!(ps, "blocked" | "failed" | "recovering")
        || matches!(
            ls,
            "awaiting_input" | "awaiting_orchestrator" | "recovering" | "failed"
        )
    {
        "blocked"
    } else if matches!(ps, "launching" | "running")
        || matches!(ls, "launching" | "running" | "paused" | "merging")
    {
        "running"
    } else {
        "ready"
    }
}
pub(super) fn read(reader: &NativeReads, db: &Connection, args: &Value) -> ReadResult<Value> {
    // Brief/context generation and remote job authority remain on the original
    // path until those observation contracts are available to passive readers.
    if args["includeBrief"] == true || args["includeDetails"] == true {
        return Err(());
    }
    for key in ["repoPath", "projectId"] {
        if args
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err(());
        }
    }
    if args["projectId"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return Err(());
    }
    let state = mission::current(reader, db)?;
    let packets = array(&state["packets"])?;
    let lanes = lanes(db)?;
    if lanes
        .iter()
        .any(|lane| lane["lastEventAt"].is_null() && !lane["lastHeartbeatAt"].is_null())
    {
        return Err(());
    }
    let repos = registries::registry(reader)?;
    let mut tasks = Vec::new();
    for (packet, lane) in packets
        .iter()
        .map(|p| (p, &Value::Null))
        .chain(lanes.iter().map(|l| (&Value::Null, l)))
    {
        if lane["runtime"] == "cloud" {
            return Err(());
        }
        let packet_task = !packet.is_null();
        let source = if packet_task { packet } else { lane };
        if source["projectId"].as_str().is_some_and(|s| s.trim() != s) {
            return Err(());
        }
        if let Some(timestamp) = source["lastEventAt"].as_str() {
            let parsed = DateTime::parse_from_rfc3339(timestamp).map_err(|_| ())?;
            if iso(parsed.timestamp_millis())? != timestamp {
                return Err(());
            }
        }
        let path = if packet_task {
            &packet["workspaceTargetPath"]
        } else {
            &lane["repoPath"]
        };
        let path = path.as_str().map(str::trim).filter(|s| !s.is_empty());
        if let Some(path) = path {
            let normalized = std::path::Path::new(path).components().collect::<PathBuf>();
            if !normalized.is_absolute() || normalized.to_str() != Some(path) {
                return Err(());
            }
        }
        if args["repoPath"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some_and(|wanted| path != Some(wanted))
        {
            continue;
        }
        let group = group(packet, lane);
        if group == "done" && args["includeDone"] != true {
            continue;
        }
        let mut repo_name = path
            .map(|path| {
                std::path::Path::new(path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or(())
            })
            .transpose()?
            .map(str::to_owned);
        if let Some(repo) = repos.iter().find(|repo| repo["localPath"].as_str() == path) {
            let explicit = source["projectId"]
                .as_str()
                .filter(|s| !s.trim().is_empty());
            let ledger = registries::projects(reader, db)?;
            let projects = array(&ledger["projects"])?;
            let settings = registries::sqlite_projects(db)?;
            let requested = explicit.map(str::to_lowercase);
            let settings_match = requested.as_ref().and_then(|requested| {
                settings.iter().find(|p| {
                    p["id"]
                        .as_str()
                        .is_some_and(|s| s.to_lowercase() == *requested)
                        || p["slug"] == *requested
                })
            });
            if settings_match.is_some() {
                return Err(());
            }
            let panel = requested
                .as_ref()
                .and_then(|requested| {
                    projects.iter().find(|p| {
                        p["id"]
                            .as_str()
                            .is_some_and(|s| s.to_lowercase() == *requested)
                            || p["name"]
                                .as_str()
                                .is_some_and(|s| registries::slug(s) == *requested)
                    })
                })
                .or_else(|| {
                    settings_match.and_then(|setting| {
                        projects
                            .iter()
                            .find(|p| p["id"] == setting["id"] || p["name"] == setting["name"])
                    })
                });
            if explicit.is_none()
                || panel.is_some_and(|p| {
                    p["repoPaths"]
                        .as_array()
                        .is_some_and(|paths| paths.contains(&repo["localPath"]))
                })
            {
                repo_name = Some(string(repo, "name")?.to_owned());
            }
        }
        let task = json!({"id":source["id"],"packetId":if packet_task {packet["id"].clone()} else {Value::Null},
            "laneId":if packet_task {Value::Null} else {lane["id"].clone()},"title":if packet_task {packet["title"].clone()} else {lane["label"].clone()},
            "group":group,"status":source["status"],"runtime":source["runtime"],"repoName":repo_name,
            "branch":if packet_task {&packet["branchTarget"]} else {&lane["branch"]},"queueState":packet["queueState"],"releaseState":packet["releaseState"],
            "blockedReason":packet["blockedReason"],"lastEventAt":source["lastEventAt"],"execution":null});
        tasks.push(task);
    }
    tasks.sort_by(|a, b| {
        let rank = |v: &Value| GROUPS.iter().position(|g| v["group"] == *g).unwrap_or(5);
        rank(a).cmp(&rank(b)).then_with(|| {
            b["lastEventAt"]
                .as_str()
                .unwrap_or("")
                .cmp(a["lastEventAt"].as_str().unwrap_or(""))
        })
    });
    let mut groups = serde_json::Map::new();
    let mut counts = serde_json::Map::new();
    for group in GROUPS {
        let ids = tasks
            .iter()
            .filter(|t| t["group"] == group)
            .map(|t| t["id"].clone())
            .collect::<Vec<_>>();
        counts.insert(group.into(), json!(ids.len()));
        groups.insert(group.into(), json!(ids));
    }
    Ok(json!({"schema":"o8/mcp/task.pool/v1","tasks":tasks,"groups":groups,"counts":counts}))
}
