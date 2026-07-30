# Canonical workflow

Every o8 task follows one governed loop: define the outcome, isolate execution, inspect evidence, authorize integration, and record what happened.

1. **Define the outcome.** Create a mission or packet with a concrete objective, scope, constraints, and completion checks. A strong brief names what may change and what must remain untouched.
2. **Split independent work.** Use multiple packets only when their scopes can progress independently. Dependencies stay explicit so a downstream packet does not start from an unverified assumption.
3. **Dispatch through a runtime.** o8 binds the packet to a lane, creates its isolated workspace, and launches the selected worker adapter with the project brief.
4. **Observe real progress.** Lifecycle events, heartbeats, terminal output, artifacts, and diffs establish whether the worker is active and whether the intended entry point reaches the change.
5. **Recover visibly.** Steer a warm lane when the direction is close, retry after a transient failure, or rerun with new feedback when the approach must change. A stopped or blocked lane remains explicit.
6. **Review the diff.** Review evaluates the actual repository change, the verification evidence, and any scope overlap. Findings are recorded against the packet rather than left only in chat.
7. **Authorize integration.** An operator approval opens the merge path. Worker-context approval requests become inbox items; they do not grant the worker merge authority.
8. **Close the loop.** The resulting commit, review, approval, and outcome enter the audit history. Useful lessons can become durable Cortex observations or directives.

The app, CLI, and MCP surface use the same objects and gates. The [orchestration playbook](orchestration-playbook.md) explains how to make the loop efficient, and [How o8 works](how-o8-works.md) explains the underlying model.
