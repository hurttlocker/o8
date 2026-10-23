//! Cross-process fixture: exercises production restart admission without app cleanup.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = std::path::PathBuf::from(&args[1]);
    let completed = root.join("native-cleanup");
    let guard = o8_restart_safety::RestartSafety::new(root, move || {
        std::fs::write(&completed, "cleanup").unwrap();
    });
    let result = guard
        .prepare_with_work(args.get(2).is_some_and(|value| value == "force"))
        .and_then(|id| {
            if args.get(2).is_some_and(|value| value == "reserve") {
                println!("{id}");
                use std::io::Write;
                std::io::stdout().flush().unwrap();
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).unwrap();
                guard.cancel(&id)
            } else {
                guard.before_restart(Some(&id))
            }
        });
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
