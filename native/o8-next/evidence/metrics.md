# Static saved-session measurements

Three fresh native processes, release build, locked gpui 0.2.2. Each process loaded
the production GET contracts from a fresh disposable route host, selecting the
longest of three persisted fixture sessions (120 stored messages, server returns
the latest 100). Viewport 1200 x 816. The host used the actual handlers, not a
mock response. No operator histories, installed app, OS input or visible windows.

| Run | Home/End to CPU scene acknowledgment, median ms | First changed scroll scene, median ms | Idle RSS MiB | Launch to first content scene ms | Streaming |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 2.80 | 1.79 | 41.48 | 197.79 | Deferred |
| 2 | 2.74 | 1.57 | 40.97 | 217.82 | Deferred |
| 3 | 2.51 | 1.57 | 41.06 | 219.56 | Deferred |
| Median of runs | 2.74 | 1.57 | 41.06 | 217.82 | Deferred |

Each run acknowledged the first and last content rows, with 100 distinct rows
reaching paint over navigation. Even sample counts use the mean of the two middle
observations for the median.

Raw observations: `run-1.json`, `run-2.json`, `run-3.json`. Key samples use two
explicit CPU draws ending in an acknowledged paint callback, as in #4362. Scroll
cost times the **first** changed draw; #4362 timed a warmed second draw. These
numbers therefore do not support a direct scroll speed ratio to that spike.
Cold start includes session discovery/history HTTP and the initial 10 ms readiness
poll. It excludes starting the server. Idle RSS is sampled after the first content
scene, before navigation. No cache clearing or machine-idle claim is made.

These are CPU scene/layout/paint endpoints. `Window::draw` does not submit the GPU
scene or present a frame. Headless timing does not represent GPU execution,
compositor scheduling, input-device latency, display synchronization or photons.
Static snapshot navigation is not composer input or a live stream benchmark.
Authored persisted fixture sessions are not live provider-session acceptance.

Recommendation: retain pure Rust GPUI for the next opt-in slice. It now consumes
real server contracts and passes the bounded web render-tree comparison without
a JavaScript UI bridge or excluded application crates. Keep the existing shipped
surface until live event correctness, completed-turn layout retention, broader
rich-content parity and measurements on disposable provider sessions are proven.
PR #4362 remains the separate, unmerged draft spike record. Its four-arm table
remains there; these measurements do not replace it or imply a production speedup.
