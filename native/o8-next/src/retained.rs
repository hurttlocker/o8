//! Retained transcript text layout. Only content or viewport-width changes reshape
//! a row. Moving/repainting an unchanged row reuses its shaped lines and height.
use crate::{
    model::Row,
    text::{Node, Run},
};
use gpui::{
    App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId, InspectorElementId,
    IntoElement, LayoutId, Pixels, Point, Size, Style, TextAlign, TextRun, Window, WrappedLine,
    font, point, px, rgb, size,
};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

pub struct RowState {
    pub row: Row,
    pub layouts: usize,
    cache: Option<Layout>,
}
impl RowState {
    pub fn new(row: Row) -> Self {
        Self {
            row,
            layouts: 0,
            cache: None,
        }
    }
}
struct Line {
    line: WrappedLine,
    origin: Point<Pixels>,
    height: Pixels,
    align: TextAlign,
}
struct Backdrop {
    bounds: Bounds<Pixels>,
    color: u32,
}
struct Layout {
    size: Size<Pixels>,
    lines: Vec<Line>,
    backgrounds: Vec<Backdrop>,
}
struct Builder {
    width: Pixels,
    y: Pixels,
    lines: Vec<Line>,
    backgrounds: Vec<Backdrop>,
}
impl Builder {
    fn rich_node(&mut self, kind: &str, data: &serde_json::Value, window: &Window) {
        let label = |value: &serde_json::Value| value.as_str().unwrap_or("").to_owned();
        if kind == "table" {
            let headers = data["headers"].as_array().cloned().unwrap_or_default();
            let width = (self.width - px(48.)) / headers.len().max(1) as f32;
            let mut rows = vec![headers];
            rows.extend(
                data["rows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|row| row.as_array().cloned()),
            );
            for (row_index, cells) in rows.iter().enumerate() {
                let top = self.y;
                let mut bottom = top;
                for (column, cell) in cells.iter().enumerate() {
                    let mut builder = Builder {
                        width: width + px(48.),
                        y: top,
                        lines: vec![],
                        backgrounds: vec![],
                    };
                    let mut runs: Vec<Run> =
                        serde_json::from_value(cell.clone()).unwrap_or_default();
                    if row_index == 0 {
                        for run in &mut runs {
                            run.style = "strong".into();
                        }
                    }
                    builder.text(&runs, 13., 19.5, 0., window);
                    for mut line in builder.lines {
                        line.origin.x += width * column as f32;
                        line.align = match data["aligns"][column].as_str() {
                            Some("right") => TextAlign::Right,
                            Some("center") => TextAlign::Center,
                            _ => TextAlign::Left,
                        };
                        self.lines.push(line);
                    }
                    bottom = bottom.max(builder.y);
                }
                self.y = bottom + px(8.);
                self.backgrounds.push(Backdrop {
                    bounds: Bounds::new(point(px(24.), self.y), size(self.width - px(48.), px(1.))),
                    color: 0x343b45,
                });
                self.y += px(4.);
            }
            return;
        }
        let lines = match kind {
            "handoff" => {
                let source = data["from"]["model"]
                    .as_str()
                    .or(data["from"]["backend"].as_str())
                    .unwrap_or("Unknown source");
                let destination = data["to"]["model"]
                    .as_str()
                    .or(data["to"]["backend"].as_str())
                    .unwrap_or("Unknown destination");
                let mut lines = vec![
                    format!("{source} → {destination}"),
                    if data["lossless"] == true {
                        "Lossless same-session handoff"
                    } else {
                        "Cold handoff"
                    }
                    .into(),
                ];
                for layer in [
                    "narrative",
                    "intent",
                    "workspace",
                    "governance",
                    "provenance",
                ] {
                    lines.push(format!("{layer}: {}", label(&data["carries"][layer])));
                }
                let packet = &data["packet"];
                if packet["workspace"].is_object() {
                    lines.push(format!(
                        "Workspace: {} · {}",
                        label(&packet["workspace"]["branch"]),
                        if packet["workspace"]["dirty"] == true {
                            "uncommitted changes present"
                        } else {
                            "clean"
                        }
                    ));
                }
                if packet["governance"].is_object() {
                    lines.push(format!(
                        "Governance: {} packets · {} approvals",
                        packet["governance"]["packets"]
                            .as_array()
                            .map_or(0, Vec::len),
                        packet["governance"]["approvals"]
                            .as_array()
                            .map_or(0, Vec::len)
                    ));
                }
                if let Some(model) = packet["narrative"]["compactedBy"]["model"].as_str() {
                    lines.push(format!("Compacted by {model}"));
                }
                lines
            }
            "compaction" => vec![
                "Context compacted".into(),
                format!(
                    "{} → {} tokens · {} compaction",
                    data["tokensBefore"],
                    data["tokensAfter"],
                    label(&data["trigger"])
                ),
                label(&data["summary"]),
                format!(
                    "Archive: {} · {}",
                    label(&data["archiveRef"]),
                    label(&data["compactedBy"]["model"])
                ),
            ],
            "media" => vec![
                format!(
                    "[{} placeholder] {}",
                    label(&data["kind"]),
                    label(&data["name"])
                ),
                format!("{} · {}", label(&data["mimeType"]), label(&data["path"])),
            ],
            _ => vec![],
        };
        let top = self.y;
        self.y += px(8.);
        for line in lines.into_iter().filter(|line| !line.is_empty()) {
            self.plain(crate::text::sanitize(&line), 12., 18., window);
        }
        self.y += px(8.);
        self.backgrounds.push(Backdrop {
            bounds: Bounds::new(
                point(px(24.), top),
                size(self.width - px(48.), self.y - top),
            ),
            color: 0x242a33,
        });
    }
    fn text(
        &mut self,
        runs: &[Run],
        font_size: f32,
        line_height: f32,
        inset: f32,
        window: &Window,
    ) {
        let text: String = runs.iter().map(|r| r.text.as_str()).collect();
        let styled: Vec<TextRun> = runs.iter().map(text_run).collect();
        let width = (self.width - px(48. + inset * 2.)).max(px(1.));
        let lines = window
            .text_system()
            .shape_text(text.into(), px(font_size), &styled, Some(width), None)
            .expect("valid text runs");
        if lines.is_empty() {
            self.y += px(line_height);
        }
        for line in lines {
            let height = line.size(px(line_height)).height;
            self.lines.push(Line {
                line,
                origin: point(px(24. + inset), self.y),
                height: px(line_height),
                align: TextAlign::Left,
            });
            self.y += height;
        }
    }
    fn plain(&mut self, text: String, font_size: f32, line_height: f32, window: &Window) {
        self.text(
            &[Run {
                style: "text".into(),
                text,
            }],
            font_size,
            line_height,
            0.,
            window,
        );
    }
    fn node(&mut self, node: &Node, window: &Window) {
        if let Some(data) = &node.data {
            self.rich_node(&node.kind, data, window);
            return;
        }
        if node.kind == "break" {
            self.y += px(6.);
            return;
        }
        if node.kind == "rule" {
            self.y += px(12.);
            self.backgrounds.push(Backdrop {
                bounds: Bounds::new(point(px(24.), self.y), size(self.width - px(48.), px(1.))),
                color: 0x343b45,
            });
            self.y += px(13.);
            return;
        }
        let code = node.kind == "code-block" || node.kind == "diff-card";
        let top = self.y;
        if code {
            self.y += px(18.);
            self.text(
                &[Run {
                    style: "text".into(),
                    text: node.language.clone().unwrap_or_default(),
                }],
                10.,
                15.,
                10.,
                window,
            );
        }
        if node.kind.starts_with('h') {
            self.y += px(8.);
        }
        let prefix = if node.kind == "ul" {
            "• ".into()
        } else if let Some(n) = node.kind.strip_prefix("ol:") {
            format!("{n} ")
        } else if node.kind == "quote" {
            "│ ".into()
        } else {
            String::new()
        };
        let mut runs = vec![];
        if !prefix.is_empty() {
            runs.push(Run {
                style: "text".into(),
                text: prefix,
            });
        }
        runs.extend(node.runs.clone());
        if node.kind == "diff-card" {
            for line in node.runs.iter().flat_map(|run| run.text.split('\n')) {
                self.text(
                    &[Run {
                        text: line.into(),
                        style: if line.starts_with('+') {
                            "diff-add"
                        } else if line.starts_with('-') {
                            "diff-remove"
                        } else {
                            "code"
                        }
                        .into(),
                    }],
                    12.,
                    19.5,
                    10.,
                    window,
                );
            }
        } else {
            self.text(
                &runs,
                if code { 12. } else { 13. },
                19.5,
                if code { 10. } else { 0. },
                window,
            );
        }
        if node.kind.starts_with('h') {
            self.y += px(4.);
        }
        if code {
            self.y += px(18.);
            self.backgrounds.push(Backdrop {
                bounds: Bounds::new(
                    point(px(24.), top + px(8.)),
                    size(self.width - px(48.), self.y - top - px(16.)),
                ),
                color: 0x16191e,
            });
        }
    }
}
fn layout(row: &Row, width: Pixels, window: &Window) -> Layout {
    let mut b = Builder {
        width,
        y: px(8.),
        lines: vec![],
        backgrounds: vec![],
    };
    match row {
        Row::PacketHeader {
            prompt, details, ..
        } => {
            b.plain(
                crate::text::sanitize(
                    details
                        .as_ref()
                        .and_then(|d| d["title"].as_str())
                        .unwrap_or("Dispatched packet"),
                ),
                11.,
                16.,
                window,
            );
            if let Some(details) = details {
                for field in ["branch", "runtime", "status", "repo"] {
                    if let Some(value) = details[field].as_str() {
                        b.plain(
                            crate::text::sanitize(&format!("{field}: {value}")),
                            10.,
                            15.,
                            window,
                        );
                    }
                }
                if !details["launchContext"].is_null() {
                    b.plain(
                        crate::text::sanitize(&details["launchContext"].to_string()),
                        10.,
                        15.,
                        window,
                    );
                }
            }
            for node in crate::text::markdown(prompt) {
                b.node(&node, window);
            }
        }
        Row::Message { role, nodes, .. } => {
            b.plain(
                match role.as_str() {
                    "user" => "Operator",
                    "assistant" => "Agent",
                    other => other,
                }
                .into(),
                9.5,
                14.,
                window,
            );
            b.y += px(4.);
            for node in nodes {
                b.node(node, window);
            }
        }
        Row::Activity { steps, .. } => {
            b.plain("Work details".into(), 11., 16., window);
            let mut previous = None;
            for step in steps {
                if previous != Some(step.group) {
                    b.y += px(4.);
                    previous = Some(step.group);
                }
                b.text(
                    &[Run {
                        style: "code".into(),
                        text: format!("{} · {}", step.status, crate::text::sanitize(&step.command)),
                    }],
                    11.,
                    16.,
                    0.,
                    window,
                );
                if let Some(reason) = &step.reason {
                    b.plain(crate::text::sanitize(reason), 11., 16., window);
                }
            }
        }
    }
    Layout {
        size: size(width, b.y + px(8.)),
        lines: b.lines,
        backgrounds: b.backgrounds,
    }
}
pub struct RetainedRow {
    pub state: Rc<RefCell<RowState>>,
    pub index: usize,
    pub painted: Rc<RefCell<BTreeSet<usize>>>,
}
impl IntoElement for RetainedRow {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for RetainedRow {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        _: &mut App,
    ) -> (LayoutId, ()) {
        let state = self.state.clone();
        let mut style = Style::default();
        style.size.width = gpui::relative(1.).into();
        let id = window.request_measured_layout(style, move |known, available, window, _| {
            let width = known.width.unwrap_or(match available.width {
                AvailableSpace::Definite(w) => w,
                _ => px(1000.),
            });
            let mut state = state.borrow_mut();
            if state
                .cache
                .as_ref()
                .is_none_or(|cache| cache.size.width != width)
            {
                state.cache = Some(layout(&state.row, width, window));
                state.layouts += 1;
            }
            state.cache.as_ref().unwrap().size
        });
        (id, ())
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut Window,
        _: &mut App,
    ) {
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        let state = self.state.borrow();
        let cache = state.cache.as_ref().expect("measured row");
        for background in &cache.backgrounds {
            window.paint_quad(gpui::fill(
                Bounds::new(
                    bounds.origin + background.bounds.origin,
                    background.bounds.size,
                ),
                rgb(background.color),
            ));
        }
        for line in &cache.lines {
            line.line
                .paint_background(
                    bounds.origin + line.origin,
                    line.height,
                    line.align,
                    None,
                    window,
                    cx,
                )
                .unwrap();
            line.line
                .paint(
                    bounds.origin + line.origin,
                    line.height,
                    line.align,
                    None,
                    window,
                    cx,
                )
                .unwrap();
        }
        self.painted.borrow_mut().insert(self.index);
    }
}

fn text_run(run: &Run) -> TextRun {
    let mut face = font(if run.style == "code" || run.style.starts_with("diff-") {
        "Menlo"
    } else {
        ".AppleSystemUIFont"
    });
    face.weight = if run.style == "strong" {
        gpui::FontWeight::MEDIUM
    } else {
        gpui::FontWeight::LIGHT
    };
    if run.style == "em" {
        face.style = gpui::FontStyle::Italic;
    }
    TextRun {
        len: run.text.len(),
        font: face,
        color: rgb(if run.style == "diff-add" {
            0x8bd49c
        } else if run.style == "diff-remove" {
            0xec9b9b
        } else if run.style == "link" {
            0x8cb4e8
        } else {
            0xe8ecf2
        })
        .into(),
        background_color: if run.style == "code" {
            Some(rgb(0x242a33).into())
        } else {
            None
        },
        underline: None,
        strikethrough: if run.style == "strike" {
            Some(gpui::StrikethroughStyle {
                thickness: px(1.),
                color: None,
            })
        } else {
            None
        },
    }
}
