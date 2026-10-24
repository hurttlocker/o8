// Original Apache-2.0 native surface. All UI comes from the published gpui crate.
mod activity;
mod client;
mod merge;
mod model;
mod retained;
mod stream;
mod text;
mod transport;
mod ui;
use crate::{
    client::Client,
    model::{History, render_tree},
};
use serde_json::json;
use std::{env, fs, process::ExitCode, time::Instant};

fn run() -> Result<(), String> {
    let started = Instant::now();
    let args: Vec<String> = env::args().skip(1).collect();
    if args == ["--help"] {
        println!(
            "o8-next --enable-next --server http://127.0.0.1:PORT [--offscreen] [--benchmark FILE]\nRead-only saved session snapshot. No app or data-directory discovery.\no8-next --render-tree HISTORY.json"
        );
        return Ok(());
    }
    if args.first().is_some_and(|s| s == "--replay-tree") && args.len() == 2 {
        let replay: stream::Replay =
            serde_json::from_slice(&fs::read(&args[1]).map_err(|_| "Cannot read replay")?)
                .map_err(|_| "Invalid replay")?;
        let mut transcript = stream::Transcript::new(replay.initial);
        for message in replay.frames {
            transcript.apply(&message);
        }
        println!("{}", serde_json::to_string(&transcript.rows).unwrap());
        return Ok(());
    }
    if args.first().is_some_and(|s| s == "--render-tree") && args.len() == 2 {
        let history: History =
            serde_json::from_slice(&fs::read(&args[1]).map_err(|_| "Cannot read recording")?)
                .map_err(|_| "Invalid recording")?;
        println!(
            "{}",
            serde_json::to_string(&render_tree(&history.transcript)).unwrap()
        );
        return Ok(());
    }
    let mut server = None;
    let mut offscreen = false;
    let mut enabled = false;
    let mut benchmark = None;
    let mut unattended = false;
    let mut stream_output = None;
    let mut stream_through = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--enable-next" => enabled = true,
            "--offscreen" => offscreen = true,
            "--unattended-on-screen" => unattended = true,
            "--server" | "--benchmark" | "--stream-benchmark" | "--stream-through" => {
                i += 1;
                let value = args.get(i).ok_or("Missing flag value")?.clone();
                if args[i - 1] == "--server" {
                    server = Some(value);
                } else if args[i - 1] == "--benchmark" {
                    benchmark = Some(value);
                } else if args[i - 1] == "--stream-benchmark" {
                    stream_output = Some(value);
                } else {
                    stream_through = Some(
                        value
                            .parse::<u64>()
                            .map_err(|_| "Invalid stream sequence")?,
                    );
                }
            }
            _ => return Err("Unknown argument; use --help".into()),
        }
        i += 1;
    }
    if !enabled {
        return Err("This surface is opt-in; pass --enable-next".into());
    }
    if (benchmark.is_some() || stream_output.is_some()) && !offscreen {
        return Err("Automated benchmarks require --offscreen".into());
    }
    let stream_benchmark = match (stream_output, stream_through) {
        (Some(path), Some(seq)) if seq > 0 && benchmark.is_none() => Some((path, seq)),
        (None, None) => None,
        _ => {
            return Err(
                "Use --stream-benchmark FILE with --stream-through SEQ, without --benchmark".into(),
            );
        }
    };
    let client =
        Client::new(&server.ok_or("Pass --server with an explicit disposable server origin")?)?;
    // The real session list and history reads are also exercised without a window
    // by the parity/protocol runner. Interactive reads happen off the UI thread.
    ui::launch(
        client,
        offscreen,
        unattended,
        benchmark,
        stream_benchmark,
        started,
    );
    Ok(())
}
fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", json!({"error": error}));
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recorded_web_parity() {
        for case in ["review", "tools", "long"] {
            let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
            let history: History = serde_json::from_slice(
                &fs::read(base.join(format!("{case}.history.json"))).unwrap(),
            )
            .unwrap();
            let expected: serde_json::Value =
                serde_json::from_slice(&fs::read(base.join(format!("{case}.tree.json"))).unwrap())
                    .unwrap();
            assert_eq!(
                serde_json::to_value(render_tree(&history.transcript)).unwrap(),
                expected,
                "{case}"
            );
        }
    }
}
