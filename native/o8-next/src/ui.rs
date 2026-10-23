use crate::{
    client::{Client, Session},
    model::{Row, render_tree},
    text::{Node, Run},
};
use gpui::{
    App, Application, Bounds, Context, FocusHandle, KeyDownEvent, Keystroke, ListAlignment,
    ListState, Render, StyledText, TextRun, Window, WindowBounds, WindowHandle, WindowOptions,
    canvas, div, font, list, point, prelude::*, px, rgb, size,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    fs,
    process::Command,
    rc::Rc,
    time::Instant,
};

struct Surface {
    client: Client,
    sessions: Vec<Session>,
    selected: Option<String>,
    rows: Rc<Vec<Row>>,
    list: ListState,
    focus: FocusHandle,
    notice: String,
    generation: u64,
    list_generation: u64,
    key_revision: u64,
    painted: Rc<Cell<u64>>,
    painted_rows: Rc<RefCell<BTreeSet<usize>>>,
}
impl Surface {
    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        self.generation += 1;
        let generation = self.generation;
        self.selected = Some(id.clone());
        self.rows = Rc::new(vec![]);
        self.list = ListState::new(0, ListAlignment::Top, px(400.));
        self.notice = "Reading history…".into();
        cx.notify();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.history(&id).map(|h| render_tree(&h.transcript)) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                match result {
                    Ok(rows) => {
                        this.list = ListState::new(rows.len(), ListAlignment::Top, px(400.));
                        this.rows = Rc::new(rows);
                        this.notice = this.snapshot_label();
                    }
                    Err(error) => this.notice = error,
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn snapshot_label(&self) -> String {
        let count = self
            .selected
            .as_ref()
            .and_then(|id| self.sessions.iter().find(|s| &s.id == id))
            .map(|s| s.message_count)
            .unwrap_or(0);
        if self.rows.is_empty() {
            "No saved messages. Select Refresh to read again.".into()
        } else if count > 100 {
            format!("Read-only snapshot · latest 100 of {count} saved messages · Refresh to update")
        } else {
            "Read-only snapshot · Refresh to update".into()
        }
    }
    fn load_sessions(&mut self, cx: &mut Context<Self>) {
        self.list_generation += 1;
        self.generation += 1;
        let generation = self.list_generation;
        self.notice = "Reading sessions…".into();
        cx.notify();
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.sessions() });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.list_generation {
                    return;
                }
                match result {
                    Ok(sessions) => {
                        this.sessions = sessions;
                        if let Some(id) = this
                            .selected
                            .clone()
                            .filter(|id| this.sessions.iter().any(|s| &s.id == id))
                            .or_else(|| this.sessions.first().map(|s| s.id.clone()))
                        {
                            this.select(id, cx);
                        } else {
                            this.generation += 1;
                            this.selected = None;
                            this.rows = Rc::new(vec![]);
                            this.list = ListState::new(0, ListAlignment::Top, px(400.));
                            this.notice = "No saved orchestrator sessions.".into();
                        }
                    }
                    Err(error) => this.notice = format!("{error}. Select Refresh to retry."),
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn navigate(&mut self, end: bool, cx: &mut Context<Self>) {
        if !self.rows.is_empty() {
            self.list
                .scroll_to_reveal_item(if end { self.rows.len() - 1 } else { 0 });
        }
        self.key_revision += 1;
        cx.notify();
    }
}

fn text_run(run: &Run) -> TextRun {
    let mut face = font(if run.style == "code" {
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
        color: rgb(if run.style == "link" {
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
fn node(node: &Node) -> gpui::AnyElement {
    if node.kind == "break" {
        return div().h(px(6.)).into_any_element();
    }
    if node.kind == "rule" {
        return div()
            .h(px(1.))
            .my(px(12.))
            .bg(rgb(0x343b45))
            .into_any_element();
    }
    let code = node.kind == "code-block";
    let mut container = div()
        .flex()
        .flex_col()
        .w_full()
        .min_w_0()
        .text_size(px(if code { 12. } else { 13. }))
        .line_height(px(19.5));
    if code {
        container = container
            .p(px(10.))
            .my(px(8.))
            .rounded(px(6.))
            .bg(rgb(0x16191e))
            .child(
                div()
                    .text_size(px(10.))
                    .text_color(rgb(0x8a93a0))
                    .child(node.language.clone().unwrap_or_default()),
            );
    }
    if node.kind.starts_with('h') {
        container = container.mt(px(8.)).mb(px(4.));
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
    let mut runs = Vec::new();
    if !prefix.is_empty() {
        runs.push(Run {
            style: "text".into(),
            text: prefix,
        });
    }
    runs.extend(node.runs.clone());
    // Explicit line elements preserve code indentation/newlines and permit wrapping.
    let mut line = Vec::<Run>::new();
    for run in runs {
        for (i, part) in run.text.split('\n').enumerate() {
            if i > 0 {
                container = container.child(styled_line(&line));
                line.clear();
            }
            if !part.is_empty() {
                line.push(Run {
                    style: run.style.clone(),
                    text: part.into(),
                });
            }
        }
    }
    container.child(styled_line(&line)).into_any_element()
}
fn styled_line(runs: &[Run]) -> gpui::AnyElement {
    if runs.is_empty() {
        return div().h(px(19.5)).into_any_element();
    }
    div()
        .min_w_0()
        .child(
            StyledText::new(runs.iter().map(|r| r.text.as_str()).collect::<String>())
                .with_runs(runs.iter().map(text_run).collect()),
        )
        .into_any_element()
}
fn row(row: &Row, index: usize, painted: Rc<RefCell<BTreeSet<usize>>>) -> gpui::AnyElement {
    let mut container = div()
        .id(gpui::ElementId::Name(row.id().to_owned().into()))
        .flex()
        .flex_col()
        .px(px(24.))
        .py(px(8.))
        .w_full()
        .min_w_0();
    match row {
        Row::Message { role, nodes, .. } => {
            container = container.child(
                div()
                    .text_size(px(9.5))
                    .text_color(rgb(0x8a93a0))
                    .mb(px(4.))
                    .child(
                        if role == "user" {
                            "Operator"
                        } else if role == "assistant" {
                            "Agent"
                        } else {
                            role
                        }
                        .to_owned(),
                    ),
            );
            container = container.children(nodes.iter().map(node));
        }
        Row::Activity { steps, .. } => {
            container = container.child(
                div()
                    .text_size(px(11.))
                    .text_color(rgb(0x8a93a0))
                    .child("Work details"),
            );
            let mut previous = None;
            for step in steps {
                if previous != Some(step.group) {
                    container = container.child(div().h(px(4.)));
                    previous = Some(step.group);
                }
                container = container.child(div().text_size(px(11.)).font_family("Menlo").child(
                    format!("{} · {}", step.status, crate::text::sanitize(&step.command)),
                ));
                if let Some(reason) = &step.reason {
                    container = container.child(
                        div()
                            .text_size(px(11.))
                            .text_color(rgb(0xb7bfca))
                            .child(crate::text::sanitize(reason)),
                    );
                }
            }
        }
    }
    container
        .relative()
        .child(
            canvas(
                |_, _, _| (),
                move |_, _, _, _| {
                    painted.borrow_mut().insert(index);
                },
            )
            .absolute()
            .w(px(1.))
            .h(px(1.)),
        )
        .into_any_element()
}
impl Render for Surface {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows.clone();
        let painted_rows = self.painted_rows.clone();
        let painted = self.painted.clone();
        let revision = self.key_revision;
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0x1a1e24))
            .text_color(rgb(0xe8ecf2))
            .font_family(".AppleSystemUIFont")
            .font_weight(gpui::FontWeight::LIGHT)
            .text_size(px(13.))
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                match event.keystroke.key.as_str() {
                    "home" => this.navigate(false, cx),
                    "end" => this.navigate(true, cx),
                    _ => return,
                }
                cx.stop_propagation();
            }))
            .child(
                div()
                    .h(px(40.))
                    .px(px(16.))
                    .flex()
                    .items_center()
                    .gap(px(16.))
                    .child("o8 next")
                    .child(
                        div()
                            .id("refresh")
                            .px(px(8.))
                            .py(px(4.))
                            .rounded(px(5.))
                            .cursor_pointer()
                            .bg(rgb(0x282e38))
                            .child("Refresh")
                            .on_click(cx.listener(|this, _, _, cx| this.load_sessions(cx))),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .child(
                        div()
                            .id("sessions")
                            .w(px(250.))
                            .flex_shrink_0()
                            .overflow_y_scroll()
                            .px(px(8.))
                            .children(self.sessions.iter().map(|session| {
                                let id = session.id.clone();
                                div()
                                    .id(gpui::ElementId::Name(id.clone().into()))
                                    .px(px(12.))
                                    .py(px(8.))
                                    .rounded(px(8.))
                                    .cursor_pointer()
                                    .bg(rgb(if self.selected.as_ref() == Some(&id) {
                                        0x303744
                                    } else {
                                        0x1a1e24
                                    }))
                                    .child(div().text_size(px(13.5)).child(session.title.clone()))
                                    .child(
                                        div()
                                            .mt(px(4.))
                                            .text_size(px(9.5))
                                            .text_color(rgb(0x8a93a0))
                                            .child(format!(
                                                "{} · {} · {} messages",
                                                session.runtime,
                                                session.status,
                                                session.message_count
                                            )),
                                    )
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.select(id.clone(), cx)
                                    }))
                            })),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .px(px(24.))
                                    .py(px(8.))
                                    .text_size(px(11.))
                                    .text_color(rgb(0x8a93a0))
                                    .child(self.notice.clone()),
                            )
                            .child(
                                list(self.list.clone(), move |index, _, _| {
                                    row(&rows[index], index, painted_rows.clone())
                                })
                                .flex_1(),
                            ),
                    ),
            )
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, _, _, _| {
                        painted.set(revision);
                    },
                )
                .w(px(1.))
                .h(px(1.)),
            )
    }
}
fn frame(
    handle: WindowHandle<Surface>,
    cx: &mut App,
    key: Option<&str>,
    scroll: Option<usize>,
) -> (f64, f64) {
    let start = Instant::now();
    let cost = cx
        .update_window(handle.into(), |root, window, cx| {
            let view = root.downcast::<Surface>().unwrap();
            if let Some(key) = key {
                window.dispatch_keystroke(Keystroke::parse(key).unwrap(), cx);
            }
            if let Some(index) = scroll {
                view.update(cx, |v, cx| {
                    v.list.scroll_to_reveal_item(index);
                    cx.notify();
                });
            }
            let draw = Instant::now();
            window.refresh();
            window.draw(cx).clear();
            let cost = draw.elapsed().as_secs_f64() * 1000.;
            window.refresh();
            window.draw(cx).clear();
            cost
        })
        .unwrap();
    (start.elapsed().as_secs_f64() * 1000., cost)
}
fn rss() -> f64 {
    let output = Command::new("ps")
        .args(["-p", &std::process::id().to_string(), "-o", "rss="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .unwrap()
        / 1024.
}
pub fn launch(
    client: Client,
    offscreen: bool,
    unattended: bool,
    benchmark: Option<String>,
    started: Instant,
) {
    (if offscreen { Application::headless() } else { Application::new() }).run(move |cx: &mut App| {
        let sessions = vec![]; let rows = vec![]; let selected = None; let row_count = 0;
        let handle = cx.open_window(WindowOptions { focus: false, show: !offscreen,
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(point(px(if offscreen { -10000. } else { 100. }), px(if offscreen { -10000. } else { 100. })), size(px(1200.), px(816.))))),
            titlebar: Some(gpui::TitlebarOptions { title: Some("o8 next".into()), ..Default::default() }),
            ..Default::default() }, |window, cx| cx.new(|cx| {
                let focus = cx.focus_handle(); focus.focus(window);
                let mut surface = Surface { client, sessions, selected, rows: Rc::new(rows), list: ListState::new(row_count, ListAlignment::Top, px(400.)), focus,
                    notice: String::new(), generation: 0, list_generation: 0, key_revision: 0, painted: Rc::new(Cell::new(u64::MAX)), painted_rows: Rc::new(RefCell::new(BTreeSet::new())) };
                surface.notice = surface.snapshot_label();
                surface.load_sessions(cx);
                surface
            })).expect("GPUI window");
        cx.on_window_closed(|cx| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        if unattended {
            cx.spawn(async move |cx| {
                for i in 0..70 {
                    cx.background_executor().timer(std::time::Duration::from_millis(100)).await;
                    let _ = handle.update(cx, |surface, _, cx| surface.navigate(i%2 == 0, cx));
                }
                cx.update(|cx| cx.quit()).unwrap();
            }).detach();
        }
        if let Some(path) = benchmark {
            cx.spawn(async move |cx| {
                let mut ready = false;
                for _ in 0..600 {
                    cx.background_executor().timer(std::time::Duration::from_millis(10)).await;
                    ready = cx.update(|cx| !handle.read(cx).unwrap().rows.is_empty()).unwrap();
                    if ready { break; }
                }
                assert!(ready, "session list and selected history must load through the interactive path");
                cx.update(|cx| {
                    frame(handle, cx, None, None);
                    let row_count = handle.read(cx).unwrap().rows.len();
                    assert!(handle.read(cx).unwrap().painted_rows.borrow().contains(&0), "first content row must reach paint");
                    let cold = started.elapsed().as_secs_f64()*1000.;
                    let idle = rss(); let mut keys = Vec::<Value>::new(); let mut scrolls = Vec::<Value>::new();
                    for i in 0..20 {
                        let (latency, _) = frame(handle, cx, Some(if i%2 == 0 { "end" } else { "home" }), None);
                        let painted = handle.read(cx).unwrap().painted.get(); assert_eq!(painted, i+1, "input must reach paint callback");
                        keys.push(json!(latency));
                    }
                    for i in 0..50 { let (_, cost) = frame(handle, cx, None, Some(if i%2 == 0 { row_count.saturating_sub(1) } else { 0 })); scrolls.push(json!(cost)); }
                    assert!(handle.read(cx).unwrap().painted_rows.borrow().contains(&(row_count-1)), "last content row must reach paint after End/scroll");
                    let result = json!({"endpoint":"GPUI CPU scene paint callback; no GPU submission or presentation", "keyToFrameMs":keys, "scrollFrameMs":scrolls,
                        "streamFrameMs":null, "idleMemoryMiB":idle, "coldStartMs":cold, "rows":row_count, "paintedRows":handle.read(cx).unwrap().painted_rows.borrow().len(), "sessions":handle.read(cx).unwrap().sessions.len(), "offscreen":offscreen});
                    fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).expect("result file"); cx.quit();
                }).unwrap();
            }).detach();
        }
    });
}
