// Original Apache-2.0 benchmark code. UI imports are exclusively from gpui.
// No editor, terminal, markdown, or other GPL application crate is used.
use gpui::{
    App, Application, Bounds, Context, FocusHandle, KeyDownEvent, Keystroke, ListAlignment,
    ListState, Render, StyledText, TextRun, Window, WindowBounds, WindowHandle, WindowOptions,
    canvas, div, font, list, point, prelude::*, px, rgb, size,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::BTreeSet,
    fs,
    process::Command,
    rc::Rc,
    time::{Duration, Instant},
};

const HASH: &str = "46471f2c5a78d461e9e11b4f30129a23f18aee84644b856cd2440373e85ae238";
const TOKENS: [&str; 8] = [
    " amber", " garden", " river", " steady", " path", " light", " field", " stone",
];

#[derive(Deserialize)]
struct Turn {
    role: String,
    text: String,
    #[serde(rename = "toolCalls", default)]
    tool_calls: Vec<Value>,
}
#[derive(Clone)]
struct Line {
    text: String,
    runs: Vec<TextRun>,
    code: bool,
    heading: bool,
}

fn lines(source: &str) -> Vec<Line> {
    let mut fenced = false;
    source
        .lines()
        .filter_map(|raw| {
            if raw.starts_with("```") {
                fenced = !fenced;
                return None;
            }
            let heading = raw.starts_with('#');
            let raw = if heading {
                raw.trim_start_matches('#').trim_start()
            } else {
                raw
            };
            let raw = if let Some(item) = raw.strip_prefix("- ") {
                format!("• {item}")
            } else {
                raw.to_owned()
            };
            let mut text = String::new();
            let mut runs = Vec::new();
            let mut mono = fenced;
            for (i, part) in raw.split('`').enumerate() {
                if i > 0 {
                    mono = !mono;
                }
                let part = part.replace("**", "");
                if part.is_empty() {
                    continue;
                }
                runs.push(TextRun {
                    len: part.len(),
                    font: font(if mono { "Menlo" } else { ".AppleSystemUIFont" }),
                    color: rgb(0xe8ecf2).into(),
                    background_color: if mono {
                        Some(rgb(0x1b1e23).into())
                    } else {
                        None
                    },
                    underline: None,
                    strikethrough: None,
                });
                text.push_str(&part);
            }
            if text.is_empty() {
                text.push(' ');
                runs.push(TextRun {
                    len: 1,
                    font: font(".AppleSystemUIFont"),
                    color: rgb(0xe8ecf2).into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                });
            }
            Some(Line {
                text,
                runs,
                code: fenced,
                heading,
            })
        })
        .collect()
}

#[derive(Default)]
struct Painted {
    built_rows: BTreeSet<usize>,
    input: String,
    tokens: usize,
    frames: usize,
}
struct Transcript {
    rows: Rc<Vec<Vec<Line>>>,
    roles: Rc<Vec<String>>,
    tail: Vec<Line>,
    prefix: String,
    list: ListState,
    input: String,
    focus: FocusHandle,
    tokens: usize,
    painted: Rc<RefCell<Painted>>,
}
impl Transcript {
    fn row(lines: &[Line], role: &str) -> gpui::AnyElement {
        div()
            .flex()
            .flex_col()
            .px(px(16.))
            .py(px(6.))
            .w_full()
            .bg(rgb(if role == "user" { 0x1b1e23 } else { 0x0c0e11 }))
            .children(lines.iter().map(|line| {
                let mut element = div()
                    .text_size(px(if line.code { 12. } else { 13. }))
                    .line_height(px(if line.code { 18. } else { 19.5 }))
                    .child(StyledText::new(line.text.clone()).with_runs(line.runs.clone()));
                if line.heading {
                    element = element.py(px(4.));
                }
                element
            }))
            .into_any_element()
    }
}
impl Render for Transcript {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.rows.clone();
        let roles = self.roles.clone();
        let tail = self.tail.clone();
        let input = self.input.clone();
        let tokens = self.tokens;
        let painted = self.painted.clone();
        let built = self.painted.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0x0c0e11))
            .text_color(rgb(0xe8ecf2))
            .font_family(".AppleSystemUIFont")
            .text_size(px(13.))
            .child(
                div()
                    .h(px(38.))
                    .flex_shrink_0()
                    .px(px(16.))
                    .py(px(10.))
                    .text_size(px(12.))
                    .child("Transcript · 2,000 invented turns"),
            )
            .child(
                list(self.list.clone(), move |index, _, _| {
                    built.borrow_mut().built_rows.insert(index);
                    Self::row(
                        if index == 1999 { &tail } else { &rows[index] },
                        &roles[index],
                    )
                })
                .flex_1(),
            )
            .child(
                div()
                    .id("composer")
                    .track_focus(&self.focus)
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                        if let Some(text) = &event.keystroke.key_char {
                            this.input.push_str(text);
                            cx.notify();
                            cx.stop_propagation();
                        }
                    }))
                    .h(px(44.))
                    .flex_shrink_0()
                    .mx(px(16.))
                    .mb(px(8.))
                    .p(px(8.))
                    .bg(rgb(0x1b1e23))
                    .child(if self.input.is_empty() {
                        "Message this worker".into()
                    } else {
                        self.input.clone()
                    }),
            )
            // GPUI invokes this paint callback after the composer in each frame.
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, _, _, _| {
                        let mut receipt = painted.borrow_mut();
                        receipt.input = input.clone();
                        receipt.tokens = tokens;
                        receipt.frames += 1;
                    },
                )
                .w(px(1.))
                .h(px(1.)),
            )
    }
}

enum Action {
    None,
    Stream(usize),
    Scroll(usize),
    Key,
}
fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}

fn frame(handle: WindowHandle<Transcript>, cx: &mut App, action: Action) -> Value {
    let start = Instant::now();
    let draw_ms = cx
        .update_window(handle.into(), |root, window, cx| {
            let view = root.downcast::<Transcript>().expect("transcript root");
            match action {
                Action::Key => {
                    window.dispatch_keystroke(Keystroke::parse("w").unwrap(), cx);
                }
                Action::Stream(n) => view.update(cx, |view, cx| {
                    view.tokens = n;
                    let mut text = view.prefix.clone();
                    for i in 0..n {
                        text.push_str(TOKENS[i % TOKENS.len()]);
                    }
                    view.tail = lines(&text);
                    view.list.splice(1999..2000, 1);
                    cx.notify();
                }),
                Action::Scroll(index) => view.update(cx, |view, cx| {
                    view.list.scroll_to_reveal_item(index);
                    cx.notify();
                }),
                Action::None => (),
            }
            // Two real GPUI CPU scene draws match the GPUIX test-flush boundary.
            // The paint callback above acknowledges the resulting input/tail state.
            window.refresh();
            window.draw(cx).clear();
            let draw = Instant::now();
            window.refresh();
            window.draw(cx).clear();
            ms(draw)
        })
        .unwrap();
    json!({"elapsedMs": ms(start), "drawMs": draw_ms})
}

fn rss_mib() -> f64 {
    let output = Command::new("ps")
        .args(["-p", &std::process::id().to_string(), "-o", "rss="])
        .output()
        .unwrap();
    String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse::<f64>()
        .unwrap()
        / 1024.
}

fn main() {
    let started = Instant::now();
    let fixture_path = std::env::var("BENCH_FIXTURE").expect("BENCH_FIXTURE");
    let result_path = std::env::var("BENCH_RESULT").expect("BENCH_RESULT");
    let fixture = fs::read(&fixture_path).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&fixture)), HASH);
    let turns: Vec<Turn> = serde_json::from_slice(&fixture).unwrap();
    assert_eq!(turns.len(), 2000);
    let rows = Rc::new(
        turns
            .iter()
            .map(|turn| {
                if turn.role == "tool" {
                    let command = turn
                        .tool_calls
                        .first()
                        .and_then(|tool| tool.get("args"))
                        .and_then(|args| args.get("command"))
                        .and_then(Value::as_str)
                        .unwrap();
                    lines(&format!("Work details · {command}"))
                } else {
                    lines(&turn.text)
                }
            })
            .collect::<Vec<_>>(),
    );
    let roles = Rc::new(
        turns
            .iter()
            .map(|turn| turn.role.clone())
            .collect::<Vec<_>>(),
    );
    let prefix = turns[1999].text.clone();
    Application::new().run(move |cx: &mut App| {
        let painted = Rc::new(RefCell::new(Painted::default()));
        let receipt = painted.clone();
        let handle = cx.open_window(WindowOptions {
            focus: false, show: false,
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(point(px(-10000.), px(-10000.)), size(px(1200.), px(816.))))),
            titlebar: None, ..Default::default()
        }, |window, cx| {
            cx.new(|cx| {
                let focus = cx.focus_handle();
                focus.focus(window);
                Transcript { tail: rows[1999].clone(), rows, roles, prefix,
                    list: ListState::new(2000, ListAlignment::Bottom, px(800.)),
                    input: String::new(), focus, tokens: 0, painted }
            })
        }).unwrap();
        cx.update_window(handle.into(), |_, window, _| {
            assert_eq!(window.viewport_size(), size(px(1200.), px(816.)));
        }).unwrap();
        frame(handle, cx, Action::None);
        assert!(receipt.borrow().frames >= 2, "GPUI paint callback missing");
        assert!(receipt.borrow().built_rows.contains(&1999), "Initial transcript tail was not built");
        let cold = ms(started);
        println!("{}", json!({"kind":"first-frame"}));
        let idle = rss_mib();
        let mut stream = Vec::new(); let mut keys = Vec::new(); let mut scroll = Vec::new();
        frame(handle, cx, Action::Scroll(1999));
        let stream_start = Instant::now();
        for n in 1..=80 {
            std::thread::sleep(Duration::from_millis(n as u64 * 20).saturating_sub(stream_start.elapsed()));
            stream.push(frame(handle, cx, Action::Stream(n)));
            assert_eq!(receipt.borrow().tokens, n);
            if n % 4 == 0 {
                keys.push(frame(handle, cx, Action::Key));
                assert_eq!(receipt.borrow().input, "w".repeat(n / 4));
            }
        }
        let stream_ms = ms(stream_start);
        for n in (19..2000).step_by(20) { scroll.push(frame(handle, cx, Action::Scroll(n))); }
        let result = json!({"surface":"pure", "fixtureHash":HASH,"rows":2000,"width":1200,"height":816,
            "stream":stream,"keys":keys,"scroll":scroll,"tokens":80,"inputAcknowledged":20,
            "streamMs":stream_ms,"tokensPerSecond":80000./stream_ms,"coldInAppMs":cold,"idleRssMiB":idle,
            "paintCallbacks":receipt.borrow().frames,"processMs":ms(started),
            "measurement":"gpui 0.2.2 hidden-window CPU scene draw completion and paint callback; no presentation"});
        fs::write(result_path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        cx.quit();
    });
}
