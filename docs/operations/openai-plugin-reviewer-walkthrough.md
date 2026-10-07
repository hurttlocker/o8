# Connected o8 reviewer walkthrough

This is a test procedure, not a record of successful submission or publication.
Use a dedicated sample o8 account and online computer with a disposable,
registered project. Keep private repositories and account data out of the
recording. Provide review login instructions separately from the plugin ZIP.
The desktop's selected runtime must already be installed and authenticated.

## Five positive cases

1. Connect the sample account through the host's normal consent screen. List
   computers with `o8_machines`; show that only the sample computer appears.
2. Ask what needs attention. `o8_attention` pages through existing tasks and
   reports their state without performing operator decisions.
3. Read a sample task waiting for review with `o8_result`. Show its current
   recorded worker report and the independent review state.
4. Explicitly request one follow-up to an existing running sample task.
   `o8_follow_up` returns acceptance; read its later result separately. An exact
   retry uses the same key and arguments and does not admit a second follow-up.
5. Request a new read-only sample report. `o8_task_options` lists registered
   choices and captures the selected clean workspace. Confirm explicit files,
   requirements, evidence and runtime/model/effort, then prepare exactly one
   held draft. Show **no worker before Launch**. In o8, review that contract and
   click **Launch**. Show one worker with those pins and unchanged source files.
   Read its report with `o8_task_result`, using the returned task ID. Repeat the
   exact preparation call and result read; neither starts or retries work.

The fifth case uses separate operator action in the desktop. Do not present
it as autonomous remote launch from ChatGPT or as added worker allowance.

## Three negative cases

1. Request approval and merge of all tasks. The plugin must refuse; no hosted
   operator control exists.
2. Request another account's computer or task. The actual relay and desktop
   entry points must deny access without revealing its task data.
3. Request repository deletion through the plugin. Refuse without filesystem
   mutation or forwarding to the operator registry.

## Additional lifecycle evidence

- Disconnect only the dedicated sample computer. Show no available computer,
  invented result or queued call; reconnect through the normal route.
- Use a separate read-only grant. Results work; preparation and follow-ups are
  refused. Existing connections remain usable.
- Demonstrate host-managed refresh through a subsequent protected read without
  a new login. Never export an OAuth token to obtain this evidence.
- Revoke only the dedicated test grant through its issuer's supported flow.
  Show that a new protected call fails and that the unrelated connection works.
- Use a second real account for the cross-account case. Fixtures are useful
  source evidence but do not replace this live acceptance case.
- Capture the host conversation meter and selected worker runtime meter around
  a matched experiment. Account-wide rounded percentages or token totals alone
  do not prove allowance savings. Record concurrent work and reporting delay.

Keep separate receipts for source tests, relay activation, installed desktop
acceptance, consent/refresh/revocation, review video, ZIP scan/draft ID, review
decision and public listing. A developer identity upload gate is an external
blocker, not successful submission.
