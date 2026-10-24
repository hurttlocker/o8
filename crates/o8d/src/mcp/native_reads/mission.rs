use super::*;

pub(super) fn current(reader: &NativeReads, db: &Connection) -> ReadResult<Value> {
    let file = reader.json("orchestrator-state.json")?;
    if file["version"] != 1 {
        return Err(());
    }
    let mission = file["mission"].clone();
    let packets = array(&mission["packets"])?;
    let lanes = lanes(db)?;
    // Runtime bindings, release reconciliation and dispatch admission retain
    // their existing owners. An unbound prepared mission is a passive read.
    for packet in packets {
        if !packet["lane"].is_null()
            || packet["status"] != "queued"
            || packet["workspaceTargetPath"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            || lanes.iter().any(|lane| lane["packetId"] == packet["id"])
            || packet["manualLaunchClaim"].is_object()
            || !packet["archivedAt"].is_null()
            || packet["operatorStopped"] == true
            || packet["queueState"] != "queued"
            || !packet["storageAdmission"].is_null()
            || !packet["holdIntent"].is_null()
            || !packet["hold"].is_null()
            || !array(&packet["dependencyPacketIds"])?.is_empty()
            || packet["preflightRefusals"].as_i64().is_some_and(|n| n > 0)
            || packet["releaseState"] != "pending"
            || !packet["blockedReason"].is_null()
        {
            return Err(());
        }
    }
    Ok(mission)
}
fn wave(index: usize, packets: &[Value], visited: &mut Vec<usize>) -> ReadResult<u64> {
    if visited.contains(&index) {
        return Ok(1);
    }
    if visited.len() > 256 {
        return Err(());
    }
    visited.push(index);
    let mut depth = 0;
    for dependency in array(&packets[index]["dependencyPacketIds"])? {
        if let Some(index) = packets.iter().position(|p| p["id"] == *dependency) {
            depth = depth.max(wave(index, packets, visited)?);
        }
    }
    visited.pop();
    Ok(depth + 1)
}
pub(super) fn read(reader: &NativeReads, db: &Connection, args: &Value) -> ReadResult<Value> {
    if args["includeCost"] == true || args["includeTiming"] == true {
        return Err(());
    }
    let state = current(reader, db)?;
    let id = string(&state, "missionId")?;
    if id.is_empty() {
        return Err(());
    }
    if args
        .get("missionId")
        .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(());
    }
    if args["missionId"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.trim() != id)
    {
        return Err(());
    }
    let packets = array(&state["packets"])?;
    let artifacts = rows(
        db,
        "SELECT packet_id FROM artifacts WHERE kind != 'receipt'",
    )?;
    let mut projected = Vec::new();
    let mut blockers = Vec::new();
    let mut waves = Vec::new();
    for (index, packet) in packets.iter().enumerate() {
        if artifacts.iter().any(|a| a["packet_id"] == packet["id"]) {
            return Err(());
        }
        let dependencies = array(&packet["dependencyPacketIds"])?;
        let mut blocked = Vec::new();
        for dependency in dependencies {
            if !blocked.contains(dependency)
                && !packets
                    .iter()
                    .any(|p| p["id"] == *dependency && p["releaseState"] == "released")
            {
                blocked.push(dependency.clone());
            }
        }
        let wave = wave(index, packets, &mut Vec::new())?;
        waves.push(wave);
        if !blocked.is_empty()
            || packet["blockedReason"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        {
            blockers.push(json!({"packetId":packet["id"],"blockedBy":blocked,"reason":packet["blockedReason"]}));
        }
        let review = if packet["review"].is_null() {
            Value::Null
        } else {
            let p = &packet["review"];
            json!({"approved":p["approved"],"findingsCount":array(&p["findings"])?.len(),"summary":p["summary"],"recordedAt":p["recordedAt"],"reviewedHeadSha":p["reviewedHeadSha"],"auditApprovalId":p["auditApprovalId"]})
        };
        projected.push(json!({"id":packet["id"],"referenceLabel":packet["referenceLabel"],"title":packet["title"],"wave":wave,
            "status":packet["status"],"runtime":packet["runtime"],"model":packet["model"].as_str().or(packet["workerRouting"]["selectedModel"].as_str()).or(packet["assignedModel"].as_str()),
            "queueState":packet["queueState"],"releaseState":packet["releaseState"],"blockedBy":blocked,"blockedReason":packet["blockedReason"],"dispatchQueue":null,
            "summary":packet["completionSummary"].as_str().map(str::trim).filter(|s| !s.is_empty()),
            "storageAdmission":packet["storageAdmission"],"spendCap":packet["spendCap"],"spendTelemetry":packet["spendTelemetry"],"recovery":packet["recovery"],"lane":null,"review":review,"artifacts":[]}));
    }
    Ok(
        json!({"missionId":id,"prompt":state["prompt"],"summary":state["summary"],"repoPath":state["repoPath"],
        "runtime":state["runtime"].as_str().unwrap_or("codex"),"constraints":state["constraints"].as_str().unwrap_or(""),
        "currentWave":waves.iter().min().copied().unwrap_or(0),"totalWaves":waves.iter().max().copied().unwrap_or(0),"packets":projected,"agents":[],"blockers":blockers}),
    )
}
