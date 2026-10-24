//! Opt-in, hidden-window CPU measurements. All input stays inside this process.
use super::*;
use gpui::AsyncApp;

async fn ready(
    handle: WindowHandle<Surface>,
    cx: &mut AsyncApp,
    operation: &str,
    predicate: impl Fn(&Surface, &App) -> bool,
) {
    let deadline = Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if cx
            .update(|cx| predicate(handle.read(cx).unwrap(), cx))
            .unwrap()
        {
            return;
        }
        assert!(Instant::now() < deadline, "fixture {operation} timed out");
        cx.background_executor()
            .timer(std::time::Duration::from_millis(2))
            .await;
    }
}

fn content_frame(handle: WindowHandle<Surface>, cx: &mut App) {
    handle.read(cx).unwrap().painted_rows.borrow_mut().clear();
    frame(handle, cx, None, None, false);
    assert!(
        handle.read(cx).unwrap().painted_rows.borrow().contains(&0),
        "selected session content must reach its own paint callback"
    );
}

pub(super) fn start(handle: WindowHandle<Surface>, path: String, started: Instant, cx: &mut App) {
    cx.spawn(async move |cx| {
        handle.update(cx, |_, window, _| assert!(!window.is_window_active())).unwrap();
        ready(handle, cx, "startup", |s, _| !s.rows.is_empty()).await;
        let (cold, initial_rows) = cx.update(|cx| {
            content_frame(handle, cx);
            (started.elapsed().as_secs_f64() * 1000., handle.read(cx).unwrap().rows.len())
        }).unwrap();
        let mut switches = vec![];
        for index in 0..10 {
            let id = if index % 2 == 0 { "thoughts-composer-first" } else { "thoughts-composer-second" };
            let start = Instant::now();
            handle.update(cx, |s, _, cx| s.select(id.into(), cx)).unwrap();
            ready(handle, cx, "sidebar history", |s, _| s.queue_ready && !s.rows.is_empty()).await;
            cx.update(|cx| {
                let s = handle.read(cx).unwrap();
                assert_eq!(s.selected.as_deref(), Some(id));
                assert_eq!(s.transcript.as_ref().unwrap().key, format!("llm-chat:{id}"));
                content_frame(handle, cx);
            }).unwrap();
            switches.push(start.elapsed().as_secs_f64() * 1000.);
        }
        // Sample a quiet composer session, after asynchronous selection settles.
        // The fixture server is a different process and is excluded from RSS.
        cx.background_executor().timer(std::time::Duration::from_millis(250)).await;
        let idle = rss();
        // Focus is GPUI-internal. The platform window remains hidden/unactivated.
        handle.update(cx, |s, window, cx| s.composer.read(cx).focus.focus(window)).unwrap();
        cx.update(|cx| { frame(handle, cx, None, None, false); }).unwrap();
        let mut keys = vec![];
        for count in 1..=20 {
            let latency = cx.update(|cx| {
                let (latency, _) = frame(handle, cx, Some("a"), None, false);
                let s = handle.read(cx).unwrap();
                let input = s.composer.read(cx);
                assert_eq!(input.text, "a".repeat(count));
                assert_eq!(input.painted, input.revision, "changed composer must paint");
                latency
            }).unwrap();
            keys.push(latency);
        }
        let draft = "a".repeat(20);
        let (retained, layouts) = cx.update(|cx| {
            let row = handle.read(cx).unwrap().rows[0].clone();
            let layouts = row.borrow().layouts;
            (row, layouts)
        }).unwrap();
        let send = Instant::now();
        // Dispatch Enter without drawing: wait for the real queue/history HTTP echo.
        handle.update(cx, |_, window, cx| {
            window.dispatch_keystroke(Keystroke::parse("enter").unwrap(), cx);
        }).unwrap();
        ready(handle, cx, "persisted send echo", |s, cx| !s.saving && s.composer.read(cx).text.is_empty() && s.rows.len() == 2).await;
        cx.update(|cx| {
            let s = handle.read(cx).unwrap();
            let item = &s.queue["items"][0];
            assert_eq!(item["status"], "applied");
            assert_eq!(item["intent"], "steer-now");
            assert_eq!(item["threadId"], "thoughts-composer-second");
            assert_eq!(item["payload"]["text"], draft);
            let last = s.transcript.as_ref().unwrap().entries.last().unwrap();
            assert_eq!(last.text, draft);
            assert_eq!(last.role, "user");
            assert_eq!(s.rows[1].borrow().row.id(), last.id);
            s.painted_rows.borrow_mut().clear();
            frame(handle, cx, None, None, true);
            let s = handle.read(cx).unwrap();
            assert!(Rc::ptr_eq(&retained, &s.rows[0]));
            assert_eq!(retained.borrow().layouts, layouts);
        }).unwrap();
        let echo = send.elapsed().as_secs_f64() * 1000.;
        handle.update(cx, |_, window, _| assert!(!window.is_window_active())).unwrap();
        let result = json!({
            "endpoint":"GPUI in-process input through two CPU draws and changed-content paint acknowledgement; no GPU submission/presentation",
            "platform":std::env::consts::OS,"release":!cfg!(debug_assertions),"offscreen":true,
            "windowRemainedInactive":true,"processDurationMs":started.elapsed().as_secs_f64()*1000.,
            "viewport":[1200,816],"initialRows":initial_rows,"keyToFrameMs":keys,
            "sendToFirstEchoMs":echo,"sidebarSwitchToFirstFrameMs":switches,
            "idleMemoryMiB":idle,"coldStartMs":cold,"unchangedRowRelayouts":0,
            "composerPaintAcknowledged":true,"persistedEchoPaintAcknowledged":true,
            "sessionContentPaintAcknowledged":true,"inputAcknowledged":20
        });
        fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).expect("composer result file");
        cx.update(|cx| cx.quit()).unwrap();
    }).detach();
}
