//! System controls — volume first ("turn it down a little").
//!
//! Classed ReadOnly in `safety` for the same reason as Music playback: no
//! data mutates and every change is instantly reversible by saying the
//! opposite — a confirm card on "turn the volume down" kills the magic.

use super::run_applescript;
use serde_json::{json, Value};

/// Read the current output volume (0-100) and mute flag.
fn read_state() -> Result<(i64, bool), String> {
    let out = run_applescript(
        r#"set s to (get volume settings)
return (output volume of s as string) & "," & (output muted of s as string)"#,
    )?;
    let mut parts = out.split(',');
    let volume = parts
        .next()
        .and_then(|p| p.trim().parse::<i64>().ok())
        .ok_or_else(|| format!("couldn't read volume state: {out}"))?;
    let muted = parts.next().map(|p| p.trim() == "true").unwrap_or(false);
    Ok((volume, muted))
}

/// `mac_volume` — get / set / nudge / mute the system output volume.
pub async fn volume(args: Value) -> Result<Value, String> {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("get");
    let step = args.get("amount").and_then(|v| v.as_i64()).unwrap_or(15).clamp(1, 100);
    let (current, muted) = read_state()?;

    let target = match action {
        "get" => return Ok(json!({ "volume": current, "muted": muted })),
        "mute" => {
            run_applescript("set volume output muted true")?;
            return Ok(json!({ "volume": current, "muted": true }));
        }
        "unmute" => {
            run_applescript("set volume output muted false")?;
            return Ok(json!({ "volume": current, "muted": false }));
        }
        "set" => args
            .get("level")
            .and_then(|v| v.as_i64())
            .ok_or("volume 'set' needs a 'level' between 0 and 100")?,
        "up" => current + step,
        "down" => current - step,
        other => return Err(format!("unknown volume action '{other}'")),
    }
    .clamp(0, 100);

    run_applescript(&format!("set volume output volume {target}"))?;
    if muted && target > 0 {
        let _ = run_applescript("set volume output muted false");
    }
    Ok(json!({ "volume": target, "muted": false, "was": current }))
}
