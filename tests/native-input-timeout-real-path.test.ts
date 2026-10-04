import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

let hasRust = false;
try { execFileSync('rustc', ['--version'], { stdio: 'ignore' }); hasRust = true; } catch { /* Native source fixture requires rustc. */ }
const rust = readFileSync(join(process.cwd(), 'tauri-plugin-mcp/src/tools/webview.rs'), 'utf8');
const handler = rust.split('pub async fn handle_type_into_focused')[1]?.split('/// Handler for wait_for')[0];
const tail = handler?.slice(handler.indexOf('    // Allow generous timeout'));
if (!tail) throw new Error('Production typing handler tail was not found');

// Compile the actual handler's timeout and evaluator call, replacing only the
// AppKit evaluator boundary. This neither builds an app nor opens a webview.
describe.skipIf(!hasRust)('production typing handler -> native evaluator timeout', () => {
  it('budgets long zero-delay rich fallback and preserves explicit pacing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'o8-native-timeout-'));
    try {
      const source = `
use std::cell::Cell;
use std::future::Future;
use std::task::{Context, Poll, Waker};
mod error { pub type Error = String; }
mod socket_server { pub struct SocketResponse { pub success: bool, pub data: Option<()>, pub error: Option<String>, pub id: Option<()> } }
const TYPE_INTO_FOCUSED_JS: &str = "production-script-boundary";
fn parse_envelope(_: ()) -> socket_server::SocketResponse { socket_server::SocketResponse { success: true, data: None, error: None, id: None } }
async fn eval_and_await(app: &Cell<u64>, label: &str, script: &str, _: (), timeout: std::time::Duration) -> Result<(), String> {
 assert_eq!(label, "main"); assert_eq!(script, TYPE_INTO_FOCUSED_JS); app.set(timeout.as_secs()); Ok(())
}
async fn production_tail(app: &Cell<u64>, text: &str, delay_ms: u64, initial_delay_ms: u64) -> Result<socket_server::SocketResponse, error::Error> {
 let window_label = "main"; let js_payload = ();
${tail}
fn budget(text: &str, delay_ms: u64, initial_delay_ms: u64) -> u64 {
 let app = Cell::new(0); let future = production_tail(&app, text, delay_ms, initial_delay_ms);
 let mut future = std::pin::pin!(future); let mut context = Context::from_waker(Waker::noop());
 assert!(matches!(future.as_mut().poll(&mut context), Poll::Ready(Ok(_)))); app.get()
}
fn main() {
 assert_eq!(budget(&"a".repeat(1000), 0, 0), 25, "zero-delay request must budget rich-editor 20ms fallback");
 assert_eq!(budget(&"a".repeat(1000), 20, 0), 25);
 assert_eq!(budget(&"a".repeat(1000), 40, 2000), 47);
 assert_eq!(budget("short", 0, 0), 10);
 // An explicitly zero-paced call with an initial delay does not select fallback.
 assert_eq!(budget(&"a".repeat(1000), 0, 1000), 10);
}
`;
      const input = join(directory, 'fixture.rs'); const binary = join(directory, 'fixture');
      writeFileSync(input, source);
      execFileSync('rustc', ['--edition=2021', '-Awarnings', input, '-o', binary], { timeout: 30000 });
      expect(() => execFileSync(binary, { timeout: 5000, stdio: 'pipe' })).not.toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
