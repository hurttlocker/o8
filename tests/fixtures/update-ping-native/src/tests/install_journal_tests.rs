use crate::launch_updater::scheduler::auto_apply::install_journal::InstallJournal;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn installation_error_never_relaunches_and_same_version_stays_failed_after_launch() {
    let directory = tempfile::tempdir().unwrap();
    let journal = InstallJournal::new(directory.path().to_path_buf());
    let restarts = AtomicUsize::new(0);
    let result = journal.install(
        "0.2.0",
        || Err("extraction failed".into()),
        || {
            restarts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(restarts.load(Ordering::SeqCst), 0);
    let relaunched = InstallJournal::new(directory.path().to_path_buf());
    assert!(relaunched.check("0.2.0").is_err());
    assert!(relaunched.check("0.2.1").is_ok());
    assert!(relaunched
        .install(
            "0.2.0",
            || panic!("must not reinstall"),
            || panic!("must not restart")
        )
        .is_err());
}
