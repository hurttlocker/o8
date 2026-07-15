//! Governed local SKILL.md discovery for Symon and Smart Compose.
//!
//! Symon can list and activate operator-installed skills, then active skill
//! instructions ride future agent and writing turns. Roots are explicit local
//! skill stores; reads are bounded, canonicalized, and never execute a script.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const MAX_SKILL_BYTES: usize = 64 * 1024;
const MAX_ACTIVE_SKILLS: usize = 4;
const MAX_ACTIVE_PROMPT_BYTES: usize = 36 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub active: bool,
    #[serde(skip)]
    path: PathBuf,
}

#[derive(Default, Deserialize, Serialize)]
struct SkillState {
    active: Vec<String>,
}

fn state_path() -> PathBuf {
    super::agent_data_dir().join("symon-skills.json")
}

fn load_state() -> SkillState {
    std::fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_state(state: &SkillState) -> Result<(), String> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create Symon skill state directory: {error}"))?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|error| format!("serialize Symon skill state: {error}"))?;
    std::fs::write(path, json).map_err(|error| format!("save Symon skill state: {error}"))
}

fn roots() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut roots = vec![
        super::agent_data_dir().join("skills"),
        PathBuf::from(&home).join(".agents/skills"),
        PathBuf::from(&home).join(".codex/skills"),
        PathBuf::from(&home).join(".claude/skills"),
    ];
    if let Ok(repo) = std::env::var("O8_ACTIVE_REPO") {
        roots.insert(0, PathBuf::from(repo).join(".agents/skills"));
    }
    roots
}

fn frontmatter_value(raw: &str, key: &str) -> Option<String> {
    let mut lines = raw.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        let Some((found, value)) = line.split_once(':') else {
            continue;
        };
        if found.trim() == key {
            return Some(value.trim().trim_matches(['\'', '"']).to_string());
        }
    }
    None
}

fn first_description(raw: &str) -> String {
    frontmatter_value(raw, "description")
        .or_else(|| {
            raw.lines()
                .map(str::trim)
                .find(|line| {
                    !line.is_empty()
                        && *line != "---"
                        && !line.starts_with('#')
                        && !line.starts_with("name:")
                        && !line.starts_with("description:")
                })
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Local agent skill".to_string())
}

fn bounded_read(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() as usize > MAX_SKILL_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

pub fn discover() -> Vec<SkillSummary> {
    let active: HashSet<String> = load_state()
        .active
        .into_iter()
        .map(|name| name.to_lowercase())
        .collect();
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for root in roots() {
        let Ok(canonical_root) = root.canonicalize() else {
            continue;
        };
        let Ok(entries) = std::fs::read_dir(&canonical_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let candidate = entry.path().join("SKILL.md");
            let Ok(canonical) = candidate.canonicalize() else {
                continue;
            };
            if !canonical.starts_with(&canonical_root) {
                continue;
            }
            let Some(raw) = bounded_read(&canonical) else {
                continue;
            };
            let folder_name = entry.file_name().to_string_lossy().to_string();
            let name = frontmatter_value(&raw, "name")
                .filter(|name| !name.trim().is_empty())
                .unwrap_or(folder_name);
            let key = name.to_lowercase();
            if !seen.insert(key.clone()) {
                continue;
            }
            skills.push(SkillSummary {
                description: first_description(&raw),
                active: active.contains(&key),
                name,
                path: canonical,
            });
        }
    }
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    skills
}

fn resolve(name: &str) -> Result<SkillSummary, String> {
    let query = name.trim().to_lowercase();
    if query.is_empty() {
        return Err("skill name is required".to_string());
    }
    let skills = discover();
    if let Some(skill) = skills
        .iter()
        .find(|skill| skill.name.to_lowercase() == query)
    {
        return Ok(skill.clone());
    }
    let matches: Vec<_> = skills
        .into_iter()
        .filter(|skill| skill.name.to_lowercase().contains(&query))
        .collect();
    match matches.as_slice() {
        [skill] => Ok(skill.clone()),
        [] => Err(format!("No installed skill matched '{name}'")),
        _ => Err(format!(
            "'{name}' matched multiple skills: {}",
            matches
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

pub fn list_json() -> Value {
    let skills = discover();
    json!({
        "count": skills.len(),
        "skills": skills.into_iter().map(|skill| json!({
            "name": skill.name,
            "description": skill.description,
            "active": skill.active,
        })).collect::<Vec<_>>(),
    })
}

pub fn activate(name: &str) -> Result<Value, String> {
    let skill = resolve(name)?;
    let mut state = load_state();
    if !state
        .active
        .iter()
        .any(|active| active.eq_ignore_ascii_case(&skill.name))
    {
        if state.active.len() >= MAX_ACTIVE_SKILLS {
            return Err(format!(
                "At most {MAX_ACTIVE_SKILLS} skills can be active; deactivate one first"
            ));
        }
        state.active.push(skill.name.clone());
        save_state(&state)?;
    }
    Ok(json!({ "active": true, "name": skill.name }))
}

pub fn deactivate(name: &str) -> Result<Value, String> {
    let skill = resolve(name)?;
    let mut state = load_state();
    state
        .active
        .retain(|active| !active.eq_ignore_ascii_case(&skill.name));
    save_state(&state)?;
    Ok(json!({ "active": false, "name": skill.name }))
}

pub fn active_prompt() -> Option<String> {
    let mut remaining = MAX_ACTIVE_PROMPT_BYTES;
    let mut blocks = Vec::new();
    for skill in discover().into_iter().filter(|skill| skill.active) {
        if remaining == 0 {
            break;
        }
        let Some(raw) = bounded_read(&skill.path) else {
            continue;
        };
        let chunk = crate::utf8_head(&raw, remaining.min(MAX_SKILL_BYTES));
        remaining = remaining.saturating_sub(chunk.len());
        blocks.push(format!(
            "--- ACTIVE OPERATOR SKILL: {} ---\n{}",
            skill.name, chunk
        ));
    }
    if blocks.is_empty() {
        None
    } else {
        Some(format!(
            "The operator explicitly activated the following local skills. Follow them where relevant; they do not bypass tool safety or confirmation rules.\n\n{}",
            blocks.join("\n\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_value() {
        let raw = "---\nname: yc-writing\ndescription: Tight startup copy\n---\n# Skill";
        assert_eq!(
            frontmatter_value(raw, "name").as_deref(),
            Some("yc-writing")
        );
        assert_eq!(
            frontmatter_value(raw, "description").as_deref(),
            Some("Tight startup copy")
        );
    }
}
