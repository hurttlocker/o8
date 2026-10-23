//! Read-only Darwin process identity. No stdin, environment secrets or mutation.
#[cfg(target_os = "macos")]
use std::ffi::CStr;
use std::ffi::OsString;

#[cfg(target_os = "macos")]
fn identity(pid: libc::pid_t) -> Option<serde_json::Value> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>();
    let count = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size as i32,
        )
    };
    if count != size as i32 || info.pbi_pid != pid as u32 || info.pbi_start_tvsec == 0 {
        return None;
    }
    let mut boot = [0u8; 128];
    let mut length = boot.len();
    let result = unsafe {
        libc::sysctlbyname(
            c"kern.bootsessionuuid".as_ptr(),
            boot.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length == 0 || length > boot.len() || info.pbi_start_tvusec >= 1_000_000 {
        return None;
    }
    let boot_id = CStr::from_bytes_until_nul(&boot).ok()?.to_str().ok()?;
    Some(
        serde_json::json!({ "version": 1, "platform": "darwin", "bootId": boot_id,
        "startId": format!("kernel:{}:{:06}", info.pbi_start_tvsec, info.pbi_start_tvusec) }),
    )
}

pub fn run(args: &[OsString]) -> i32 {
    if args.len() != 1 {
        return 1;
    }
    let Some(pid) = args[0]
        .to_str()
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|pid| *pid > 0)
    else {
        return 1;
    };
    #[cfg(target_os = "macos")]
    if let Some(value) = identity(pid) {
        println!("{value}");
        return 0;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pid;
    1
}
