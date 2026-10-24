//! Port of workspace-terminal/utils.ts mergeTranscriptEntries, used by the
//! dashboard's transcript WS bridge. Incoming windows can remove old history.
use crate::model::Entry;
use serde_json::Value;

fn trim(text: &str) -> &str {
    // ECMAScript String.trim whitespace, including BOM but excluding NEL.
    text.trim_matches(|c:char| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn index(key: &str) -> Option<u32> {
    let n = key.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}
// JSON.stringify preserves insertion order after integer property names, and
// compares numbers as JavaScript doubles. Preserve both in tool signatures.
fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut a: Vec<_> = a.iter().collect();
            let mut b: Vec<_> = b.iter().collect();
            a.sort_by_key(|(k, _)| index(k).map(|n| (0, n)).unwrap_or((1, 0)));
            b.sort_by_key(|(k, _)| index(k).map(|n| (0, n)).unwrap_or((1, 0)));
            a.len() == b.len()
                && a.into_iter()
                    .zip(b)
                    .all(|((ak, av), (bk, bv))| ak == bk && json_equal(av, bv))
        }
        _ => a == b,
    }
}
fn same(a: &Entry, b: &Entry) -> bool {
    if a.role != b.role || trim(&a.text) != trim(&b.text) {
        return false;
    }
    let a = a.tools.as_deref().unwrap_or(&[]);
    let b = b.tools.as_deref().unwrap_or(&[]);
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            let empty = serde_json::json!({});
            let aa = if a["args"].is_null() {
                &empty
            } else {
                &a["args"]
            };
            let ba = if b["args"].is_null() {
                &empty
            } else {
                &b["args"]
            };
            a["name"] == b["name"] && json_equal(aa, ba)
        })
}
fn timestamp(entry: &Entry) -> f64 {
    entry
        .extra
        .get("timestamp")
        .and_then(Value::as_f64)
        .unwrap_or(0.)
}
pub fn entries(current: &[Entry], incoming: Vec<Entry>) -> Vec<Entry> {
    let mut unused = current.to_vec();
    let mut merged = Vec::with_capacity(incoming.len());
    for mut entry in incoming {
        if let Some(index) = unused.iter().position(|old| same(old, &entry)) {
            let old = unused.remove(index);
            for key in [
                "model",
                "tokens",
                "costUsd",
                "sources",
                "thinking",
                "thinkingSteps",
                "thinkingDurationMs",
                "recalledFacts",
                "packetHeader",
            ] {
                if entry.extra.get(key).is_none_or(Value::is_null)
                    && let Some(value) = old.extra.get(key)
                {
                    entry.extra.insert(key.into(), value.clone());
                }
            }
            if entry.tools.is_none() {
                entry.tools = old.tools;
            }
        }
        merged.push(entry);
    }
    let latest = merged.iter().map(timestamp).fold(0., f64::max);
    let mut trailing: Vec<_> = unused
        .into_iter()
        .filter(|e| {
            e.id.starts_with("msg-")
                || e.id.starts_with("stream:")
                || (latest > 0. && timestamp(e) >= latest)
        })
        .filter(|e| !merged.iter().any(|other| same(e, other)))
        .collect();
    trailing.sort_by(|a, b| timestamp(a).total_cmp(&timestamp(b)));
    merged.extend(trailing);
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_web_merge_cases() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../fixtures/merge-cases.json")).unwrap();
        for case in cases {
            let current: Vec<Entry> = serde_json::from_value(case["current"].clone()).unwrap();
            let incoming: Vec<Entry> = serde_json::from_value(case["incoming"].clone()).unwrap();
            let expected: Vec<Entry> = serde_json::from_value(case["expected"].clone()).unwrap();
            assert_eq!(entries(&current, incoming), expected, "{}", case["name"]);
        }
    }
}
