use super::*;
impl Surface {
    pub(super) fn send(&mut self, promote: Option<String>, cx: &mut Context<Self>) {
        if self.saving || !self.queue_ready || self.composer.read(cx).composing() {
            return;
        }
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())
            .cloned()
        else {
            return;
        };
        let Some(repo) = session.repo_path.clone() else {
            return;
        };
        let draft = self.composer.read(cx).text.clone();
        let text = draft.trim().to_owned();
        let fresh = !self.pending.contains_key(&session.id);
        let (method, body) = if let Some(id) = promote {
            (
                "PATCH",
                json!({"repoPath":repo,"threadId":session.id,"id":id}),
            )
        } else {
            if text.is_empty() {
                return;
            }
            if let Some(pending) = self.pending.get(&session.id) {
                if pending["payload"]["text"] != text {
                    self.notice = "An earlier send is unconfirmed. Restore that draft to retry its saved identity, or inspect the shared queue.".into();
                    cx.notify();
                    return;
                }
                ("POST", pending.clone())
            } else {
                let Some(routing) = self.routing.clone() else {
                    return;
                };
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let wire = if text.starts_with('/') {
                    text.clone()
                } else {
                    format!(
                        "[Mode: Solo] Work directly in this session yourself — do NOT dispatch worker agents or create missions. Edit, run, and verify with your own tools.\n\n{text}"
                    )
                };
                let body = json!({"repoPath":repo,"threadId":session.id,"id":format!("next-{nonce:x}-{:x}", std::process::id()),
                    "intent":if !self.send_next && self.queue["canSteer"] == true { "steer-now" } else { "send-next" },
                    "payload":{"text":text,"wireMessage":wire,"images":[],"routing":routing}});
                self.pending.insert(session.id.clone(), body.clone());
                ("POST", body)
            }
        };
        self.generation += 1;
        let generation = self.generation;
        self.saving = true;
        self.notice = "Saving message…".into();
        cx.notify();
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let response = client.mutate_queue(method, &body).map_err(|error| {
                (
                    error.message,
                    error.status.is_some_and(|code| (400..500).contains(&code)),
                )
            })?;
            let item = &response["item"];
            if item["id"] != body["id"]
                || item["threadId"] != body["threadId"]
                || item["repoPath"] != body["repoPath"]
                || (method == "POST" && item["payload"] != body["payload"])
                || item["status"] == "cancelled"
            {
                return Err((
                    "Message receipt did not match. Draft retained; inspect the shared queue."
                        .into(),
                    false,
                ));
            }
            let queue = client.queue(&session);
            let history = client.history(&session.id);
            Ok::<_, (String, bool)>((method, session, queue, history))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this.saving = false;
                match result {
                    Ok((method, session, queue, history)) => {
                        if method == "POST" {
                            this.pending.remove(&session.id);
                            if this.composer.read(cx).text == draft {
                                this.composer.update(cx, |i, cx| i.clear(cx));
                            }
                        }
                        this.notice = "Message saved. Delivery status is shown below.".into();
                        match queue {
                            Ok(queue) => this.queue = queue,
                            Err(error) => this.notice = error,
                        }
                        match history {
                            Ok(history) => {
                                if let Some(transcript) = &mut this.transcript {
                                    transcript.operator_echoes(history);
                                    let rows = transcript.rows.clone();
                                    this.install_rows(rows);
                                }
                            }
                            Err(error) => this.notice = error,
                        }
                    }
                    Err((error, rejected)) => {
                        if method == "POST" && fresh && rejected {
                            if let Some(id) = &this.selected {
                                this.pending.remove(id);
                            }
                        }
                        this.notice = error;
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn reconcile(&mut self, cx: &mut Context<Self>) {
        if self.saving || !self.queue_ready {
            return;
        }
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())
            .cloned()
        else {
            return;
        };
        let generation = self.generation;
        let client = self.client.clone();
        let task = cx
            .background_executor()
            .spawn(async move { Ok::<_, String>((client.sessions()?, client.queue(&session)?)) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                match result {
                    Ok((sessions, queue)) => {
                        this.sessions = sessions;
                        this.queue = queue;
                    }
                    Err(error) => this.notice = format!("{error}. Refresh to retry."),
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub(super) fn composer_panel(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let enabled = self.queue_ready && !self.saving;
        let can_steer = self.queue["canSteer"] == true;
        let queue = self.queue["items"].as_array().cloned().unwrap_or_default();
        let queue = queue
            .into_iter()
            .filter(|item| item["status"] != "applied" && item["status"] != "cancelled");
        let routing = self
            .routing
            .as_ref()
            .map(|r| {
                format!(
                    "Solo · {} · {} · {}",
                    r["backend"].as_str().unwrap_or(""),
                    r["model"].as_str().unwrap_or(""),
                    r["permissionMode"].as_str().unwrap_or("")
                )
            })
            .unwrap_or_else(|| "Waiting for saved session routing…".into());
        div()
            .px(px(24.))
            .py(px(8.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(self.composer.clone())
            .child(div().text_size(px(9.5)).text_color(rgb(0x8a93a0)).child("Enter: send · Shift+Enter: new line · Ctrl+Shift+Enter: switch mode · F6: steer queued"))
            .child(
                div()
                    .text_size(px(10.))
                    .text_color(rgb(0x8a93a0))
                    .child(routing),
            )
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("send-mode").debug_selector(|| "send-mode".into())
                            .px(px(10.))
                            .py(px(5.))
                            .rounded(px(7.))
                            .cursor_pointer()
                            .child(if self.send_next || !can_steer {
                                "Send next"
                            } else {
                                "Steer"
                            })
                            .on_click(cx.listener(|this, _, _, cx| {
                                if !this.saving {
                                    this.send_next = !this.send_next;
                                    cx.notify();
                                }
                            })),
                    )
                    .child(
                        div()
                            .id("send")
                            .px(px(10.))
                            .py(px(5.))
                            .rounded(px(7.))
                            .bg(rgb(if enabled { 0x2563eb } else { 0x282e38 }))
                            .child(if self.saving { "Saving…" } else { "Send" })
                            .on_click(cx.listener(|this, _, _, cx| this.send(None, cx))),
                    ),
            )
            .child(div().id("composer-queue").max_h(px(120.)).overflow_y_scroll().children(queue.map(|item| {
                let id = item["id"].as_str().unwrap_or("").to_owned();
                let steerable = enabled
                    && item["status"] == "queued"
                    && item["intent"] == "send-next"
                    && item["admittedAt"].is_null()
                    && item["payload"]["afterTaskId"].is_null()
                    && self.queue["steerableIds"]
                        .as_array()
                        .is_some_and(|ids| ids.iter().any(|v| v == &id));
                div()
                    .flex()
                    .flex_col()
                    .text_size(px(11.))
                    .child(format!(
                        "{} · {}",
                        item["status"].as_str().unwrap_or("queued"),
                        item["payload"]["text"].as_str().unwrap_or("")
                    ))
                    .when(item["reason"].is_string(), |d| {
                        d.child(item["reason"].as_str().unwrap_or("").to_owned())
                    })
                    .when(steerable, |d| {
                        d.child(
                            div()
                                .id(gpui::ElementId::Name(format!("steer-{id}").into())).debug_selector(|| "steer-now".into())
                                .cursor_pointer()
                                .child("Steer now")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.send(Some(id.clone()), cx)
                                })),
                        )
                    })
            })))
            .into_any_element()
    }
}
