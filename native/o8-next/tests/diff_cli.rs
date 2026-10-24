use std::process::Command;

#[test]
fn diff_cli_is_explicit_and_documents_both_targets() {
    let binary = env!("CARGO_BIN_EXE_o8-next");
    let help = Command::new(binary).arg("--help").output().unwrap();
    assert!(help.status.success());
    let help = String::from_utf8_lossy(&help.stdout);
    assert!(help.contains("--review-packet ID"));
    assert!(help.contains("--diff-worktree PATH"));
    for args in [
        vec!["--review-packet", "fixture"],
        vec![
            "--enable-next",
            "--server",
            "http://127.0.0.1:1",
            "--review-packet",
            "fixture",
            "--diff-worktree",
            "/tmp/fixture",
        ],
        vec![
            "--enable-next",
            "--server",
            "http://127.0.0.1:1",
            "--diff-base",
            "main",
        ],
        vec![
            "--enable-next",
            "--server",
            "http://127.0.0.1:1",
            "--review-packet",
            "fixture",
            "--offscreen",
            "--benchmark",
            "/tmp/fixture.json",
        ],
    ] {
        let output = Command::new(binary).args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
    }
}
