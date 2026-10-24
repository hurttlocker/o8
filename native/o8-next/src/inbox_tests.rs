//! Production fixture routes -> shell palette -> GPUI controls -> persisted approvals.
use super::tests::{draw, open};
use super::*;
use gpui::TestAppContext;
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command as Process, Stdio},
    time::Instant,
};

struct Fixture {
    server: Child,
    client: Client,
    root: PathBuf,
    origin: String,
}
impl Fixture {
    fn new() -> Self {
        Self::start(false)
    }
    fn start(empty: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "o8-inbox-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let mut server = Process::new("node")
            .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/dev-server.ts",
                "--shell",
                "--inbox",
            ])
            .args(if empty { vec!["--inbox-empty"] } else { vec![] })
            .env("O8_NEXT_API_TOKEN", "fixture-inbox-operator-credential")
            .env("O8_NEXT_INBOX_ORACLE", root.join("oracle.json"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let origin = BufReader::new(server.stdout.take().unwrap())
            .lines()
            .find_map(|line| {
                serde_json::from_str::<Value>(&line.ok()?).ok()?["origin"]
                    .as_str()
                    .map(str::to_owned)
            })
            .expect("production Inbox fixture host must start");
        let client =
            Client::authenticated(&origin, Some("fixture-inbox-operator-credential".into()))
                .unwrap();
        Self {
            server,
            client,
            root,
            origin,
        }
    }
    fn post(&self, id: &str, action: &str) -> Value {
        ureq::post(&format!("{}/api/panel/approvals", self.origin))
            .set("Authorization", "Bearer fixture-inbox-operator-credential")
            .send_json(serde_json::json!({"action":action,"id":id}))
            .unwrap()
            .into_json()
            .unwrap()
    }
    fn records(&self) -> Vec<Value> {
        self.client
            .get::<Value>(
                "/api/panel/approvals",
                &[("status", "all"), ("scope", "all")],
            )
            .unwrap()["approvals"]
            .as_array()
            .unwrap()
            .clone()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.server.try_wait().ok().flatten().is_none() {
            let _ = Process::new("kill")
                .args(["-TERM", &self.server.id().to_string()])
                .status();
            let _ = self.server.wait();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn bounds(cx: &mut gpui::VisualTestContext, selector: &str) -> Option<Bounds<gpui::Pixels>> {
    cx.debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
}
fn click(cx: &mut gpui::VisualTestContext, selector: &str) {
    draw(cx);
    if selector.starts_with("inbox-approve-")
        || selector.starts_with("inbox-reject-")
        || selector.starts_with("inbox-open-")
    {
        for _ in 0..5 {
            let target = bounds(cx, selector).expect("card action");
            let viewport = bounds(cx, "inbox-cards").expect("scroll viewport");
            if viewport.contains(&target.center()) {
                break;
            }
            cx.simulate_event(gpui::ScrollWheelEvent {
                position: viewport.center(),
                delta: gpui::ScrollDelta::Pixels(point(
                    px(0.),
                    viewport.center().y - target.center().y,
                )),
                modifiers: Default::default(),
                touch_phase: gpui::TouchPhase::Moved,
            });
            draw(cx);
        }
    }
    let bounds =
        bounds(cx, selector).unwrap_or_else(|| panic!("missing native control: {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn inbox_cards_counts_statuses_and_approval_match_desktop_routes(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let expected: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("oracle.json")).unwrap()).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("shell.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active().unwrap().label()),
        "Inbox"
    );
    let mut counts = vec![];
    for lane in ["replies", "contributions", "approvals", "agents", "history"] {
        let cards = expected[lane].as_array().unwrap();
        counts.push(cards.len());
        assert!(!cards.is_empty(), "fixture must exercise {lane}");
        click(cx, &format!("inbox-view-{lane}"));
        assert!(bounds(cx, &format!("inbox-count-{lane}-{}", cards.len())).is_some());
        let mut last_y = None;
        for card in cards {
            let id = card["id"].as_str().unwrap();
            let card_bounds =
                bounds(cx, &format!("inbox-card-{id}")).expect("desktop card must paint in native");
            if let Some(y) = last_y {
                assert!(card_bounds.origin.y > y, "desktop route order must survive");
            }
            last_y = Some(card_bounds.origin.y);
            for field in ["status", "source"] {
                assert!(
                    bounds(
                        cx,
                        &format!("inbox-{field}-{id}-{}", card[field].as_str().unwrap())
                    )
                    .is_some(),
                    "native {field} differs for {id}"
                );
            }
        }
    }
    click(cx, "inbox-view-approvals");
    let records = fixture.records();
    let id = |title: &str| {
        records.iter().find(|a| a["title"] == title).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let native = id("Native approve");
    let desktop = id("Desktop approve");
    let rejected = id("Native reject");
    fixture.post(&desktop, "approve");
    click(cx, &format!("inbox-approve-{native}"));
    click(cx, &format!("inbox-reject-{rejected}"));
    let after = fixture.records();
    let record = |id: &str| after.iter().find(|a| a["id"] == id).unwrap();
    assert_eq!(record(&native)["status"], "approved");
    assert_eq!(record(&rejected)["status"], "rejected");
    // Compare durable decision, principal and continuation outcome, excluding generated identity/time.
    for field in ["action", "actor", "continuationStatus", "note"] {
        assert_eq!(
            record(&native)["resolution"][field],
            record(&desktop)["resolution"][field]
        );
    }
    let audit = |id: &str| {
        record(id)["audit"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| {
                (
                    event["type"].clone(),
                    event["actor"].clone(),
                    event["note"].clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(audit(&native), audit(&desktop));
    assert!(record(&native)["resolvedAt"].is_number());
    assert_eq!(record(&native)["resolution"]["actor"], "desktop");
    let after_counts = shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&Tab::Inbox)).unwrap() {
            Content::Inbox(inbox) => inbox
                .read(cx)
                .cards
                .iter()
                .map(Vec::len)
                .collect::<Vec<_>>(),
            _ => panic!("Inbox"),
        }
    });
    assert_eq!(after_counts, vec![1, 2, 2, 4, 3]);
    let uncertain = id("Unconfirmed continuation");
    let before_uncertain = record(&uncertain).clone();
    click(cx, &format!("inbox-approve-{uncertain}"));
    assert_eq!(
        fixture
            .records()
            .iter()
            .find(|a| a["id"] == uncertain)
            .unwrap(),
        &before_uncertain
    );
    println!(
        "Inbox parity counts before={counts:?} after={after_counts:?}; native approved=1 rejected=1; desktop approved=1; durable decision/audit match"
    );
    // The native transport uses the same middleware and cannot promote a worker to operator.
    let worker = Client::authenticated(
        &fixture.origin,
        Some("fixture-inbox-worker-credential".into()),
    )
    .unwrap();
    let error = worker
        .inbox_decision(&id("Worker denied"), true)
        .unwrap_err();
    assert!(
        error.contains("operator-only") || error.contains("HTTP 403"),
        "worker refusal: {error}"
    );
    assert_eq!(
        fixture
            .records()
            .iter()
            .find(|a| a["id"] == id("Worker denied"))
            .unwrap()["status"],
        "pending"
    );
}

#[gpui::test]
fn inbox_opens_related_session_and_pull_request_and_restores(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let expected: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("oracle.json")).unwrap()).unwrap();
    let file = fixture.root.join("navigation.json");
    let workspace = fixture.client.sessions().unwrap()[0]
        .repo_path
        .clone()
        .unwrap();
    let mut initial = State::default();
    initial.selected = Some(workspace.clone());
    let mut saved_workspace = Workspace {
        tabs: vec![Tab::Session("thoughts-review".into())],
        ..Default::default()
    };
    saved_workspace
        .selections
        .insert("thoughts-review".into(), "thoughts-long".into());
    initial.workspaces.insert(workspace, saved_workspace);
    initial.save(&file).unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let started = Instant::now();
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    let open_ms = started.elapsed().as_secs_f64() * 1000.;
    click(cx, "inbox-view-contributions");
    let pr = expected["contributions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|card| card["id"].as_str().unwrap().contains(":pr:"))
        .unwrap();
    click(cx, &format!("inbox-open-{}", pr["id"].as_str().unwrap()));
    assert_eq!(
        cx.cx.opened_url().as_deref(),
        Some("https://github.com/example/inbox-fixture/pull/42")
    );
    click(cx, "inbox-view-agents");
    click(
        cx,
        &format!(
            "inbox-open-{}",
            expected["agents"][0]["id"].as_str().unwrap()
        ),
    );
    assert_eq!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Session("thoughts-review".into()))
    );
    assert_eq!(
        shell.update_in(cx, |s, window, cx| {
            match s
                .content
                .get(&s.key(&Tab::Session("thoughts-review".into())))
                .unwrap()
            {
                Content::Session(session) => session.read(cx).shell_selection(window, cx).0,
                _ => None,
            }
        }),
        Some("thoughts-review".into()),
        "the related session must replace a stale saved sidebar selection"
    );
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s
            .current()
            .unwrap()
            .tabs
            .iter()
            .filter(|t| **t == Tab::Inbox)
            .count()),
        1
    );
    for (w, h) in [(900., 700.), (1680., 1050.)] {
        let handle = cx.update(|window, _| window.window_handle());
        cx.cx.simulate_window_resize(handle, size(px(w), px(h)));
        draw(cx);
        let area = bounds(cx, "inbox-cards").unwrap();
        assert!(area.origin.x >= px(0.) && area.right() <= px(w));
        for (lane, _) in crate::inbox::VIEWS {
            assert!(bounds(cx, &format!("inbox-view-{lane}")).is_some());
        }
    }
    assert!(cx.simulate_close());
    let saved = State::load(&file).unwrap();
    let (restored, mut restored_cx) = open(fixture.client.clone(), file, saved, &mut cx.cx);
    restored_cx.run_until_parked();
    draw(&mut restored_cx);
    assert_eq!(
        restored.read_with(&restored_cx, |s, _| s.active()),
        Some(Tab::Inbox)
    );
    assert!(bounds(&mut restored_cx, "inbox-view-replies").is_some());
    println!(
        "Inbox palette to loaded CPU scene: {open_ms:.2} ms; compact=900x700 wide=1680x1050; restored Inbox surfaces=1"
    );
}

#[gpui::test]
fn inbox_empty_and_server_error_never_claim_a_false_clean_state(cx: &mut TestAppContext) {
    let mut fixture = Fixture::start(true);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("empty.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    assert!(
        shell.read_with(cx, |s, _| s.workspaces.is_empty()),
        "the empty Inbox must also work before any session is saved"
    );
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    for (lane, _) in crate::inbox::VIEWS {
        click(cx, &format!("inbox-view-{lane}"));
        assert!(bounds(cx, "inbox-empty").is_some());
        assert!(bounds(cx, &format!("inbox-count-{lane}-0")).is_some());
    }
    cx.simulate_keystrokes("ctrl-w");
    assert!(shell.read_with(cx, |s, _| s.active().is_none()));
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("i n b o x enter");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        State::load(&fixture.root.join("empty.json"))
            .unwrap()
            .workspaces[""]
            .tabs,
        vec![Tab::Inbox]
    );
    let _ = Process::new("kill")
        .args(["-TERM", &fixture.server.id().to_string()])
        .status();
    fixture.server.wait().unwrap();
    click(cx, "inbox-refresh");
    assert!(shell.read_with(
        cx,
        |s, cx| match s.content.get(&s.key(&Tab::Inbox)).unwrap() {
            Content::Inbox(inbox) =>
                inbox.read(cx).error().is_some() && inbox.read(cx).errors[2].is_some(),
            _ => false,
        }
    ));
    assert!(bounds(cx, "inbox-error").is_some());
    // Debug bounds persist in TestAppContext after removal; inspect current state too.
    shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&Tab::Inbox)).unwrap() {
            Content::Inbox(inbox) => assert!(
                !inbox.read(cx).loading
                    && inbox.read(cx).loaded
                    && inbox.read(cx).error().is_some()
            ),
            _ => panic!("Inbox"),
        }
    });
}
