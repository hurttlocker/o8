//! Small read-only renderer matching the web transcript's line-oriented grammar.
use regex::{Captures, Regex};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{LazyLock, RwLock},
};

fn re(pattern: &str) -> Regex {
    static CACHE: LazyLock<RwLock<HashMap<String, Regex>>> =
        LazyLock::new(|| RwLock::new(HashMap::new()));
    if let Some(regex) = CACHE.read().unwrap().get(pattern) {
        return regex.clone();
    }
    let regex = Regex::new(pattern).expect("constant pattern");
    CACHE.write().unwrap().insert(pattern.into(), regex.clone());
    regex
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Run {
    pub style: String,
    pub text: String,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Node {
    pub kind: String,
    pub runs: Vec<Run>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}
impl Node {
    pub fn notice(text: &str) -> Self {
        Self {
            kind: "notice".into(),
            runs: vec![Run {
                style: "text".into(),
                text: text.into(),
            }],
            language: None,
        }
    }
}

pub fn sanitize(text: &str) -> String {
    let mut text = text.to_owned();
    if re(r"(?i)<(?:status|summary|task|source|action)>").is_match(&text) {
        let capture = |tag: &str| {
            re(&format!(r"(?is)<{tag}>(.*?)</{tag}>"))
                .captures(&text)
                .map(|c| c[1].trim().to_owned())
        };
        let summary = capture("summary");
        let status = capture("status");
        let task = capture("task");
        if let Some(summary) = summary {
            text = match status {
                Some(s) if !summary.to_lowercase().contains(&s.to_lowercase()) => {
                    format!("{summary} ({s})")
                }
                _ => summary,
            };
        } else if let (Some(task), Some(status)) = (task, status) {
            text = format!("{task} ({status})");
        }
    }
    text = re(r"(?is)\s*<self-review>\s*(.*?)\s*</self-review>\s*")
        .replace_all(&text, |c: &Captures| {
            serde_json::from_str::<serde_json::Value>(&c[1])
                .ok()
                .and_then(|v| v["summary"].as_str().map(|s| s.trim().to_owned()))
                .unwrap_or_default()
        })
        .into_owned();
    for pattern in [
        r"(?i)<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
        r"(?i)<<<END_UNTRUSTED_CHILD_RESULT>>>",
        r"(?i)</?[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+[^>]*>",
        r"(?i)</?(?:command-name|local-command-(?:stdout|stderr|input|result)|task-notification|task-completion-event|runtime-context|begin-untrusted-child-result|end-untrusted-child-result|untrusted-child-result|task-event|command-output|command-result|status|summary|task|source|action)[^>]*>",
    ] {
        text = re(pattern).replace_all(&text, " ").into_owned();
    }
    for (pattern, replacement) in [
        (
            r"(?i)(\bAuthorization\s*:\s*)Bearer\s+[A-Za-z0-9._~+/=-]{8,}",
            "${1}Bearer [redacted]",
        ),
        (
            r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b",
            "Bearer [redacted]",
        ),
        (
            r#"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token)\b(\s*[:=]\s*)([^\s\"'`]+)"#,
            "${1}[redacted]",
        ),
        (
            r"(?i)([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token|auth|authorization|key)=)([^&\s]+)",
            "${1}[redacted]",
        ),
        (
            r"\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})\b",
            "[redacted]",
        ),
    ] {
        text = re(pattern).replace_all(&text, replacement).into_owned();
    }
    text
}

pub fn inline(text: &str) -> Vec<Run> {
    static INLINE: LazyLock<Regex> = LazyLock::new(|| {
        re(
            r"(!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`|\[(\d{1,2})\])",
        )
    });
    let mut runs = Vec::new();
    let mut cursor = 0;
    for c in INLINE.captures_iter(text) {
        let m = c.get(0).unwrap();
        if m.start() > cursor {
            runs.push(Run {
                style: "text".into(),
                text: text[cursor..m.start()].into(),
            });
        }
        let (style, value) = if c.get(3).is_some() {
            ("image", c.get(2).unwrap().as_str())
        } else if c.get(5).is_some() {
            ("link", &c[4])
        } else if c.get(6).is_some() {
            ("strong", &c[6])
        } else if c.get(7).is_some() {
            ("em", &c[7])
        } else if c.get(8).is_some() {
            ("strike", &c[8])
        } else if c.get(9).is_some() {
            ("code", &c[9])
        } else {
            ("citation", &c[10])
        };
        runs.push(Run {
            style: style.into(),
            text: value.into(),
        });
        cursor = m.end();
    }
    if cursor < text.len() {
        runs.push(Run {
            style: "text".into(),
            text: text[cursor..].into(),
        });
    }
    runs
}

pub fn markdown(source: &str) -> Vec<Node> {
    let source = sanitize(source);
    let mut nodes = Vec::new();
    let mut fence: Option<String> = None;
    let mut code = String::new();
    for line in source.split('\n') {
        if line.starts_with("```") {
            if let Some(language) = fence.take() {
                nodes.push(Node {
                    kind: "code-block".into(),
                    runs: vec![Run {
                        style: "code".into(),
                        text: code.clone(),
                    }],
                    language: Some(language),
                });
                code.clear();
            } else {
                fence = Some(line[3..].trim().into());
            }
            continue;
        }
        if fence.is_some() {
            if !code.is_empty() {
                code.push('\n');
            }
            code.push_str(line);
            continue;
        }
        let (kind, body) = if line.trim().is_empty() {
            ("break".into(), "")
        } else if re(r"^(?:-{3,}|\*{3,}|_{3,})$").is_match(line.trim()) {
            ("rule".into(), "")
        } else if let Some(s) = line.strip_prefix("> ") {
            ("quote".into(), s)
        } else if let Some((level, body)) = (1..=4).find_map(|n| {
            line.strip_prefix(&format!("{} ", "#".repeat(n)))
                .map(|s| (n, s))
        }) {
            (format!("h{level}"), body)
        } else if let Some(m) = re(r"^\d+\.\s+").find(line) {
            (format!("ol:{}", line[..m.end()].trim()), &line[m.end()..])
        } else if let Some(m) = re(r"^[-*+]\s+").find(line) {
            ("ul".into(), &line[m.end()..])
        } else {
            ("p".into(), line)
        };
        nodes.push(Node {
            kind,
            runs: inline(body),
            language: None,
        });
    }
    if let Some(language) = fence {
        if !code.is_empty() {
            nodes.push(Node {
                kind: "code-block".into(),
                runs: vec![Run {
                    style: "code".into(),
                    text: code,
                }],
                language: Some(language),
            });
        }
    }
    nodes
}
