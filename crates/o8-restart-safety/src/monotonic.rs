//! OS counters matching Node's process.hrtime (libuv uv_hrtime), in milliseconds.
//! Persisted values are comparable across processes on the same boot.
pub fn now_ms() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        #[repr(C)]
        struct Timespec {
            seconds: std::ffi::c_long,
            nanoseconds: std::ffi::c_long,
        }
        extern "C" {
            fn clock_gettime(clock: std::ffi::c_int, time: *mut Timespec) -> std::ffi::c_int;
        }
        let mut time = Timespec {
            seconds: 0,
            nanoseconds: 0,
        };
        // Linux CLOCK_MONOTONIC, the precise counter used by uv_hrtime.
        if unsafe { clock_gettime(1, &mut time) } == 0 {
            return Some(time.seconds as f64 * 1_000.0 + time.nanoseconds as f64 / 1_000_000.0);
        }
    }
    #[cfg(target_os = "macos")]
    {
        #[repr(C)]
        struct Timebase {
            numer: u32,
            denom: u32,
        }
        extern "C" {
            fn mach_continuous_time() -> u64;
            fn mach_timebase_info(info: *mut Timebase) -> i32;
        }
        let mut base = Timebase { numer: 0, denom: 0 };
        if unsafe { mach_timebase_info(&mut base) } == 0 && base.denom != 0 {
            return Some(
                unsafe { mach_continuous_time() } as f64 * base.numer as f64
                    / base.denom as f64
                    / 1_000_000.0,
            );
        }
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn QueryPerformanceCounter(value: *mut i64) -> i32;
            fn QueryPerformanceFrequency(value: *mut i64) -> i32;
        }
        let mut counter = 0;
        let mut frequency = 0;
        if unsafe { QueryPerformanceCounter(&mut counter) } != 0
            && unsafe { QueryPerformanceFrequency(&mut frequency) } != 0
            && frequency > 0
        {
            return Some(counter as f64 / (frequency as f64 / 1_000.0));
        }
    }
    None
}
