use std::process::Command;

#[test]
fn terminal_pane_is_an_explicit_native_opt_in() {
    let binary = env!("CARGO_BIN_EXE_o8-next");
    let help = Command::new(binary).arg("--help").output().unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("--terminal SESSION_ID"));
    let denied = Command::new(binary)
        .args(["--terminal", "cortex-next-terminal-fixture"])
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(String::from_utf8_lossy(&denied.stderr).contains("opt-in"));
}
