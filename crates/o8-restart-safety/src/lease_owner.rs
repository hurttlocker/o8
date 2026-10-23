//! Same boot/start identity wire format as metadata-lock-process-identity.ts.
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const UNBOUND_MS: u128 = 30_000;
pub fn read(path: &Path) -> Value {
    if !fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Value::Null;
    }
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn command(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(status) = child.try_wait().ok()? {
            if !status.success() {
                return None;
            }
            let output = child.wait_with_output().ok()?;
            return Some(
                String::from_utf8(output.stdout)
                    .ok()?
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn identity(pid: u32) -> Option<Value> {
    #[cfg(target_os = "linux")]
    {
        let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields: Vec<_> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
        return Some(
            json!({"version":1,"platform":"linux","bootId":boot.trim(),"startId":fields.get(19)?}),
        );
    }
    #[cfg(target_os = "macos")]
    {
        let boot = command("/usr/sbin/sysctl", &["-n", "kern.bootsessionuuid"])?;
        let start = command("/bin/ps", &["-o", "lstart=", "-p", &pid.to_string()])?;
        if boot.is_empty() || start.is_empty() {
            return None;
        }
        return Some(json!({"version":1,"platform":"darwin","bootId":boot,"startId":start}));
    }
    #[cfg(windows)]
    {
        let script = format!("$process = Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction Stop; if ($null -eq $process) {{ exit 3 }}; $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks; $started = $process.CreationDate.ToUniversalTime().Ticks; [Console]::Out.Write(\"$boot $started\")");
        let result = command(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", &script],
        )?;
        let (boot, start) = result.split_once(' ')?;
        return Some(json!({"version":1,"platform":"win32","bootId":boot,"startId":start}));
    }
    #[allow(unreachable_code)]
    None
}

fn absent(pid: u32) -> bool {
    #[cfg(unix)]
    {
        extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        return pid <= i32::MAX as u32
            && unsafe {
                kill(pid as i32, 0) != 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(3)
            };
    }
    #[cfg(windows)]
    {
        // A successful empty query proves absence; command failures do not.
        return command("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command",
            &format!("$p = Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" -ErrorAction Stop; if ($null -eq $p) {{ [Console]::Out.Write('absent') }}")]).as_deref() == Some("absent");
    }
    #[allow(unreachable_code)]
    false
}

pub fn stale(value: &Value, path: &Path) -> bool {
    let pid = value["ownerPid"]
        .as_u64()
        .or_else(|| value["pid"].as_u64())
        .filter(|p| *p > 0 && *p <= i32::MAX as u64);
    let owner = &value["ownerIdentity"];
    let identified = owner["version"] == 1
        && owner["bootId"].is_string()
        && owner["startId"].is_string()
        && owner["platform"].is_string();
    if let Some(pid) = pid {
        if absent(pid as u32)
            || (identified && identity(pid as u32).is_some_and(|current| &current != owner))
        {
            return true;
        }
    }
    let created = value["createdAtMs"]
        .as_u64()
        .map(|n| n as u128)
        .or_else(|| {
            fs::metadata(path)
                .ok()?
                .modified()
                .ok()?
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|n| n.as_millis())
        });
    (value["pid"].is_null() || !identified)
        && created.is_some_and(|created| now_ms().saturating_sub(created) >= UNBOUND_MS)
}
